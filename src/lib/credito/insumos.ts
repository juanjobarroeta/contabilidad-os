// ─────────────────────────────────────────────────────────────────────────────
// Carga de insumos para el score de crédito — la capa con Prisma, separada del
// motor puro (score.ts). Junta lo que YA existe en el sistema:
//   • TaxDeclaration → ingresos declarados, impuestos pagados y puntualidad.
//   • Checklist de acuses → completitud del expediente.
//   • ComplianceSnapshot → opinión de cumplimiento del SAT.
//   • FiscalHallazgo (efos.*) → señales duras 69-B.
//   • Invoice (INGRESO, 12 meses) → facturación real, cancelaciones y
//     concentración de clientes. null si aún no hay CFDIs descargados.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { saldosFinDeMes } from "./saldos-banco";
import { declaracionesFaltantesEmpresa } from "@/lib/fiscal/cobertura-declaraciones";
import { esPersonaFisicaRfc, pagosProvisionalesAcumulan } from "@/lib/fiscal/regimen-anual";
import { desacumularIngresosDeclarados, type DeclaracionMensualInsumo, type InsumosCredito } from "./score";

/**
 * Excluye los traspasos entre cuentas propias del flujo bancario del score:
 * mover dinero entre cuentas propias infla entradas y salidas por igual.
 * Impuestos y comisiones SÍ se quedan (son salidas reales).
 *
 * TRAMPA (costó una evaluación mal calculada): `NOT: { notes: "X" }` NO incluye
 * las filas con `notes` NULL — en SQL, `NOT (notes = 'X')` es NULL, no TRUE,
 * cuando la columna es NULL. Escrito así, el filtro se comía TODOS los
 * movimientos sin categorizar (que son la mayoría) y dejaba sólo las
 * comisiones etiquetadas: el flujo bancario salía en $0 de entradas. Por eso
 * el OR explícito — no lo cambies a NOT.
 */
export const SIN_TRASPASOS_INTERNOS: Prisma.BankTransactionWhereInput = {
  OR: [{ notes: null }, { notes: { not: "INTERNAL_TRANSFER" } }],
};

export async function cargarInsumosCredito(companyId: string): Promise<InsumosCredito> {
  const empresa = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, regimenFiscal: true, regimenes: { select: { code: true } } },
  });
  const [decls, faltantes, opinion, efosAbiertos] = await Promise.all([
    prisma.taxDeclaration
      .findMany({
        where: { companyId, tipo: { in: ["IVA_MENSUAL", "ISR_PROVISIONAL", "IEPS_MENSUAL"] } },
        select: {
          tipo: true,
          periodo: true,
          isrIngresos: true,
          isrPagar: true,
          ivaPagar: true,
          iepsPagar: true,
          fechaPresentacion: true,
        },
      })
      .then((rows) =>
        rows.map((d) => ({
          ...d,
          isrIngresos: d.isrIngresos === null ? null : Number(d.isrIngresos),
          isrPagar: d.isrPagar === null ? null : Number(d.isrPagar),
          ivaPagar: d.ivaPagar === null ? null : Number(d.ivaPagar),
          iepsPagar: d.iepsPagar === null ? null : Number(d.iepsPagar),
        }))
      ),
    declaracionesFaltantesEmpresa(companyId),
    prisma.complianceSnapshot.findFirst({
      where: { companyId, tipo: "SAT_OPINION" },
      orderBy: { createdAt: "desc" },
      select: { resultado: true },
    }),
    prisma.fiscalHallazgo.count({
      where: { companyId, estado: "ABIERTO", checkClave: { startsWith: "efos." } },
    }),
  ]);

  // Un mes = varias filas (IVA/ISR/IEPS). Ingresos: los del renglón de ISR
  // (base RESICO / ingresos nominales); impuestos pagados: suma de los tres.
  const porPeriodo = new Map<string, DeclaracionMensualInsumo>();
  for (const d of decls) {
    if (!/^\d{4}-\d{2}$/.test(d.periodo)) continue; // anuales fuera
    const row =
      porPeriodo.get(d.periodo) ??
      ({ periodo: d.periodo, ingresos: null, impuestosPagados: 0, fechaPresentacion: null } as DeclaracionMensualInsumo);
    if (d.tipo === "ISR_PROVISIONAL" && d.isrIngresos != null) {
      row.ingresos = Math.max(row.ingresos ?? 0, d.isrIngresos);
    }
    row.impuestosPagados += (d.isrPagar ?? 0) + (d.ivaPagar ?? 0) + (d.iepsPagar ?? 0);
    if (d.fechaPresentacion) {
      const iso = d.fechaPresentacion.toISOString();
      if (!row.fechaPresentacion || iso < row.fechaPresentacion) row.fechaPresentacion = iso;
    }
    porPeriodo.set(d.periodo, row);
  }

  // CFDIs de INGRESO de los últimos 12 meses. Si no hay ninguno (backfill
  // pendiente / FIEL rota), la dimensión completa queda en null — el motor la
  // excluye y marca el score como provisional en vez de castigar.
  const hace12m = new Date();
  hace12m.setUTCFullYear(hace12m.getUTCFullYear() - 1);
  const [vigentesRows, cancelados, porCliente] = await Promise.all([
    prisma.invoice
      .findMany({
        where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: hace12m } },
        select: { fecha: true, total: true },
      })
      .then((rows) => rows.map((v) => ({ ...v, total: Number(v.total) }))),
    prisma.invoice.count({
      where: { companyId, tipo: "INGRESO", status: "CANCELLED", fecha: { gte: hace12m } },
    }),
    prisma.invoice.groupBy({
      by: ["customerId"],
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: hace12m }, customerId: { not: null } },
      _sum: { total: true },
    }),
  ]);

  const totalFacturado = vigentesRows.reduce((s, v) => s + v.total, 0);
  // Facturado por mes: el motor compara sólo meses con declaración presente
  // (un backfill a medias no debe leerse como subfacturación).
  const facturadoMap = new Map<string, number>();
  for (const v of vigentesRows) {
    const k = `${v.fecha.getUTCFullYear()}-${String(v.fecha.getUTCMonth() + 1).padStart(2, "0")}`;
    facturadoMap.set(k, (facturadoMap.get(k) ?? 0) + v.total);
  }
  const cfdis =
    vigentesRows.length + cancelados > 0
      ? {
          ingresosFacturados: totalFacturado,
          facturadoPorMes: [...facturadoMap.entries()].map(([periodo, total]) => ({ periodo, total })),
          emitidosVigentes: vigentesRows.length,
          emitidosCancelados: cancelados,
          topClientePct:
            totalFacturado > 0 && porCliente.length > 0
              ? (Math.max(...porCliente.map((c) => Number(c._sum.total ?? 0))) / totalFacturado) * 100
              : null,
          clientesActivos: porCliente.length,
        }
      : null;

  // Capacidad de pago: gastos facturados, nómina timbrada y flujos bancarios.
  const [egresosRows, nomina, movimientos, lotesSaldo] = await Promise.all([
    prisma.invoice
      .findMany({
        where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: hace12m } },
        select: { fecha: true, total: true },
      })
      .then((rows) => rows.map((g) => ({ ...g, total: Number(g.total) }))),
    prisma.invoice.aggregate({
      where: { companyId, tipo: "NOMINA", status: "STAMPED", fecha: { gte: hace12m } },
      _sum: { total: true },
    }),
    prisma.bankTransaction.findMany({
      where: { companyId, fecha: { gte: hace12m }, ...SIN_TRASPASOS_INTERNOS },
      select: { fecha: true, monto: true, saldo: true },
      orderBy: { fecha: "asc" },
    }),
    // Saldos declarados por los estados de cuenta subidos (el dato bueno).
    prisma.importBatch.findMany({
      where: { companyId, undoneAt: null, saldoFinal: { not: null } },
      select: { periodo: true, bankAccountId: true, saldoFinal: true, createdAt: true },
    }),
  ]);

  let bancos: InsumosCredito["bancos"] = null;
  if (movimientos.length > 0) {
    // Serie MENSUAL: habilita la ponderación por recencia, el flujo del mes
    // malo (p25) y la tabla de flujo de efectivo de la ficha.
    const porMesMap = new Map<string, { abonos: number; cargos: number }>();
    // Saldo de fin de mes: el saldo del ÚLTIMO movimiento del mes que lo trae
    // (los movimientos vienen ordenados por fecha ascendente).
    const saldoMap = new Map<string, number>();
    for (const m of movimientos) {
      const periodo = `${m.fecha.getUTCFullYear()}-${String(m.fecha.getUTCMonth() + 1).padStart(2, "0")}`;
      const acc = porMesMap.get(periodo) ?? { abonos: 0, cargos: 0 };
      const monto = Number(m.monto);
      if (monto > 0) acc.abonos += monto;
      else acc.cargos += -monto;
      porMesMap.set(periodo, acc);
      if (m.saldo != null) saldoMap.set(periodo, Number(m.saldo));
    }
    const porMes = [...porMesMap.entries()]
      .map(([periodo, v]) => ({ periodo, abonos: v.abonos, cargos: v.cargos }))
      .sort((a, b) => a.periodo.localeCompare(b.periodo));
    // El saldo de fin de mes sale del ESTADO DE CUENTA (ImportBatch), sumando
    // todas las cuentas del periodo. El saldo corrido del último movimiento
    // sólo cubre los meses sin estado: es opcional en el PDF y, con varias
    // cuentas, reportaba el saldo de una sola — de ahí salían los negativos.
    const saldosFinMes = saldosFinDeMes(
      lotesSaldo.map((l) => ({ ...l, saldoFinal: Number(l.saldoFinal) })),
      saldoMap
    ).map(({ periodo, saldo }) => ({
      periodo,
      saldo,
    }));
    const n = Math.max(1, porMes.length);
    bancos = {
      mesesConDatos: porMes.length,
      abonosProm: porMes.reduce((s, m) => s + m.abonos, 0) / n,
      cargosProm: porMes.reduce((s, m) => s + m.cargos, 0) / n,
      porMes,
      saldosFinMes,
    };
  }

  // Gastos por mes — alimenta la gráfica ingresos vs gastos de la ficha.
  const gastosMap = new Map<string, number>();
  for (const g of egresosRows) {
    const k = `${g.fecha.getUTCFullYear()}-${String(g.fecha.getUTCMonth() + 1).padStart(2, "0")}`;
    gastosMap.set(k, (gastosMap.get(k) ?? 0) + g.total);
  }

  // Cartera PPD y comportamiento de pago: los REPs (PagoDoctoRelacionado)
  // dicen QUÉ factura PPD se pagó, CUÁNTO y en QUÉ FECHA legal. Cobranza =
  // sus PPD emitidas; pagos = sus PPD recibidas (cómo paga a proveedores).
  const [ppdFacturas, doctos] = await Promise.all([
    prisma.invoice.findMany({
      where: {
        companyId,
        tipo: { in: ["INGRESO", "EGRESO"] },
        status: "STAMPED",
        metodoPago: "PPD",
        fecha: { gte: hace12m },
        uuid: { not: null },
      },
      select: { uuid: true, tipo: true, fecha: true, total: true },
    }).then((rows) => rows.map((f) => ({ ...f, total: Number(f.total) }))),
    prisma.pagoDoctoRelacionado.findMany({
      where: { pagoInvoice: { companyId } },
      select: { parentUuid: true, impPagado: true, fechaPago: true },
    }),
  ]);

  let flujosPPD: InsumosCredito["flujosPPD"] = null;
  if (ppdFacturas.length > 0) {
    const pagosPorUuid = new Map<string, { monto: number; fecha: Date | null }[]>();
    for (const d of doctos) {
      const k = d.parentUuid.trim().toUpperCase();
      const arr = pagosPorUuid.get(k) ?? [];
      arr.push({ monto: Number(d.impPagado ?? 0), fecha: d.fechaPago });
      pagosPorUuid.set(k, arr);
    }
    const lado = (tipo: "INGRESO" | "EGRESO") => {
      const facturas = ppdFacturas.filter((f) => f.tipo === tipo);
      let monto = 0;
      let pagado = 0;
      let diasPonderados = 0;
      let montoConFecha = 0;
      for (const f of facturas) {
        monto += f.total;
        const pagos = pagosPorUuid.get((f.uuid as string).trim().toUpperCase()) ?? [];
        for (const p of pagos) {
          pagado += p.monto;
          if (p.fecha && p.monto > 0) {
            const dias = (p.fecha.getTime() - f.fecha.getTime()) / 86_400_000;
            if (dias >= 0 && dias < 720) {
              diasPonderados += dias * p.monto;
              montoConFecha += p.monto;
            }
          }
        }
      }
      return {
        facturas: facturas.length,
        monto,
        pagado: Math.min(pagado, monto), // sobre-REPs no inflan el % cobrado
        diasPromedio: montoConFecha > 0 ? diasPonderados / montoConFecha : null,
      };
    };
    const cob = lado("INGRESO");
    const pag = lado("EGRESO");
    flujosPPD = {
      cobranza: {
        facturas: cob.facturas,
        monto: cob.monto,
        cobrado: cob.pagado,
        saldoInsoluto: Math.max(0, cob.monto - cob.pagado),
        diasPromedio: cob.diasPromedio,
      },
      pagos: { facturas: pag.facturas, monto: pag.monto, pagado: pag.pagado, diasPromedio: pag.diasPromedio },
    };
  }

  const resultadoOpinion = (opinion?.resultado ?? "").toUpperCase();

  // PM (Art. 14) y PF 612 (Art. 106) declaran ingresos ACUMULADOS del
  // ejercicio: desacumular ANTES de puntuar, o el score lee el year-to-date
  // como ingreso mensual (caso real: PM con límite inflado ~10×).
  let declaraciones = [...porPeriodo.values()].sort((a, b) => a.periodo.localeCompare(b.periodo));
  if (
    empresa &&
    pagosProvisionalesAcumulan({
      regimenes: [empresa.regimenFiscal, ...empresa.regimenes.map((r) => r.code)],
      esPersonaFisica: esPersonaFisicaRfc(empresa.rfc),
    })
  ) {
    declaraciones = desacumularIngresosDeclarados(declaraciones);
  }

  return {
    gastosFacturados12m: egresosRows.reduce((s, g) => s + g.total, 0),
    gastosPorMes: [...gastosMap.entries()].map(([periodo, total]) => ({ periodo, total })),
    nomina12m: Number(nomina._sum.total ?? 0),
    bancos,
    flujosPPD,
    declaraciones,
    acusesFaltantes: faltantes.length,
    opinionSat: resultadoOpinion.includes("POSITIVA")
      ? "POSITIVA"
      : resultadoOpinion.includes("NEGATIVA")
      ? "NEGATIVA"
      : null,
    efosAbiertos,
    cfdis,
  };
}
