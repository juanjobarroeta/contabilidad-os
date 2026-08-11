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

import { prisma } from "@/lib/prisma";
import { declaracionesFaltantesEmpresa } from "@/lib/fiscal/cobertura-declaraciones";
import type { DeclaracionMensualInsumo, InsumosCredito } from "./score";

export async function cargarInsumosCredito(companyId: string): Promise<InsumosCredito> {
  const [decls, faltantes, opinion, efosAbiertos] = await Promise.all([
    prisma.taxDeclaration.findMany({
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
    }),
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
    prisma.invoice.findMany({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: hace12m } },
      select: { fecha: true, total: true },
    }),
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
              ? (Math.max(...porCliente.map((c) => c._sum.total ?? 0)) / totalFacturado) * 100
              : null,
          clientesActivos: porCliente.length,
        }
      : null;

  // Capacidad de pago: gastos facturados, nómina timbrada y flujos bancarios.
  const [egresosRows, nomina, movimientos] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: hace12m } },
      select: { fecha: true, total: true },
    }),
    prisma.invoice.aggregate({
      where: { companyId, tipo: "NOMINA", status: "STAMPED", fecha: { gte: hace12m } },
      _sum: { total: true },
    }),
    prisma.bankTransaction.findMany({
      where: { companyId, fecha: { gte: hace12m } },
      select: { fecha: true, monto: true },
    }),
  ]);

  let bancos: InsumosCredito["bancos"] = null;
  if (movimientos.length > 0) {
    const meses = new Set<string>();
    let abonos = 0;
    let cargos = 0;
    for (const m of movimientos) {
      meses.add(`${m.fecha.getUTCFullYear()}-${m.fecha.getUTCMonth() + 1}`);
      if (m.monto > 0) abonos += m.monto;
      else cargos += -m.monto;
    }
    const n = Math.max(1, meses.size);
    bancos = { mesesConDatos: meses.size, abonosProm: abonos / n, cargosProm: cargos / n };
  }

  // Gastos por mes — alimenta la gráfica ingresos vs gastos de la ficha.
  const gastosMap = new Map<string, number>();
  for (const g of egresosRows) {
    const k = `${g.fecha.getUTCFullYear()}-${String(g.fecha.getUTCMonth() + 1).padStart(2, "0")}`;
    gastosMap.set(k, (gastosMap.get(k) ?? 0) + g.total);
  }

  const resultadoOpinion = (opinion?.resultado ?? "").toUpperCase();

  return {
    gastosFacturados12m: egresosRows.reduce((s, g) => s + g.total, 0),
    gastosPorMes: [...gastosMap.entries()].map(([periodo, total]) => ({ periodo, total })),
    nomina12m: nomina._sum.total ?? 0,
    bancos,
    declaraciones: [...porPeriodo.values()].sort((a, b) => a.periodo.localeCompare(b.periodo)),
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
