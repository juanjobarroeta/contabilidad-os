import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { calcularDeclaracionAnual, type DeclaracionAnualInput } from "@/lib/declaracion-anual";
import { REGIMENES_ASIMILADOS } from "@/lib/nomina/regimen";
import { sumIsrPagar } from "@/lib/isr-provisional";
import { calcularDepreciacionRegistro } from "@/lib/fiscal/activos-registro";
import { efosRfcsBloqueados } from "@/lib/fiscal/efos/service";
import { perdidasDisponibles, aplicarPerdidas, primeraActualizacion } from "@/lib/fiscal/perdidas";

// GET /api/declaracion-anual?companyId=xxx&ejercicio=2025
// Aggregates all data for the annual declaration and calculates the result.
// Manual override fields are passed as query params or stored in TaxDeclaration.

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const ejercicio = parseInt(searchParams.get("ejercicio") ?? "");

  if (!companyId || isNaN(ejercicio)) {
    return NextResponse.json({ error: "companyId y ejercicio requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, razonSocial: true, regimenFiscal: true },
  });
  if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  const yearStart = new Date(ejercicio, 0, 1);
  const yearEnd = new Date(ejercicio, 11, 31, 23, 59, 59);

  // Proveedores 69-B definitivos → sus egresos NO son deducibles (Art. 69-B);
  // se excluyen de las compras igual que en el motor provisional.
  const efosBloqueados = await efosRfcsBloqueados(companyId);
  const efosWhere = efosBloqueados.size > 0
    ? { NOT: { customer: { rfc: { in: [...efosBloqueados] } } } }
    : {};

  // ── Parallel data aggregation ──
  const [
    ingresosAgg,
    egresosPorNaturaleza,
    nominaAgg,
    isrProvisionalesAgg,
    existingAnual,
    registroDepreciacion,
    perdidasRecords,
    asimiladosAgg,
  ] = await Promise.all([
    // Total CFDI ingresos for the year
    prisma.invoice.aggregate({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: yearStart, lte: yearEnd } },
      _sum: { subtotal: true, totalImpuestos: true },
    }),
    // CFDI egresos del ejercicio, AGRUPADOS por naturaleza fiscal: las
    // INVERSION (activo fijo) se deducen vía depreciación —no como compra— y
    // las SIN_EFECTOS no son deducibles; ambas se excluyen de "compras".
    prisma.invoice.groupBy({
      by: ["naturaleza"],
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: yearStart, lte: yearEnd }, ...efosWhere },
      _sum: { subtotal: true },
    }),
    // Payroll totals for the year
    prisma.payrollItem.aggregate({
      where: {
        payrollRun: {
          companyId,
          status: { in: ["CALCULATED", "STAMPED", "PAID"] },
          fechaPago: { gte: yearStart, lte: yearEnd },
        },
      },
      _sum: {
        totalPercepciones: true,
        imssPatronal: true,
        infonavit: true,
        isrRetenido: true,
        ptu: true,
      },
    }),
    // ISR provisional payments
    prisma.taxDeclaration.findMany({
      where: {
        companyId,
        tipo: { in: ["IVA_MENSUAL", "ISR_PROVISIONAL"] },
        periodo: { startsWith: String(ejercicio) },
        status: { in: ["CALCULATED", "FILED", "PAID"] },
      },
      select: { isrPagar: true, tipo: true, periodo: true },
    }).then((rows) => rows.map((d) => ({ ...d, isrPagar: d.isrPagar === null ? null : Number(d.isrPagar) }))),
    // Check for existing saved annual declaration
    prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: "DECLARACION_ANUAL", periodo: String(ejercicio) },
    }),
    // Depreciación del registro de activo fijo (deducción de inversiones).
    calcularDepreciacionRegistro(companyId, ejercicio),
    // Pérdidas fiscales pendientes de amortizar (Art. 57).
    prisma.perdidaFiscal.findMany({ where: { companyId } }).then((rows) => rows.map((p) => ({ ...p, montoOriginal: Number(p.montoOriginal), saldoActualizado: Number(p.saldoActualizado) }))),
    // Asimilados a salarios recibidos (Art. 94): ingreso acumulable + ISR retenido
    // acreditable. Reconciliación anual de lo que se mostró mes a mes.
    prisma.invoice.aggregate({
      where: {
        companyId, tipo: "NOMINA", status: "STAMPED",
        regimenNomina: { in: REGIMENES_ASIMILADOS },
        notas: { contains: "recib", mode: "insensitive" },
        fecha: { gte: yearStart, lte: yearEnd },
      },
      _sum: { subtotal: true, isrRetenidoNomina: true },
    }),
  ]);

  const ingresosAsimilados = Number(asimiladosAgg._sum.subtotal ?? 0);
  const isrRetenidoAsimilados = Number(asimiladosAgg._sum.isrRetenidoNomina ?? 0);

  // Pérdidas disponibles, actualizadas a junio del ejercicio (Art. 57). Alimentan
  // el cálculo como default; el contador puede sobreescribir con ?perdidasAnteriores=.
  const perdidasDisp = perdidasDisponibles(
    perdidasRecords.map((p) => ({
      ejercicioOrigen: p.ejercicioOrigen,
      montoOriginal: p.montoOriginal,
      saldoActualizado: p.saldoActualizado,
      mesUltimaActualizacion: p.mesUltimaActualizacion,
      agotada: p.agotada,
      ultimoEjercicioAplicado: p.ultimoEjercicioAplicado,
    })),
    ejercicio
  );

  const ingresosCfdis = Number(ingresosAgg._sum.subtotal ?? 0);
  // Compras/deducciones inmediatas = todo EGRESO salvo INVERSION (se deduce vía
  // depreciación) y SIN_EFECTOS (no deducible). Los CFDIs sin clasificar (legacy
  // null) se tratan como gasto, igual que antes — corre el backfill de naturaleza
  // para clasificarlos. INVENTARIO sigue en compras (su costo de lo vendido es
  // Fase 3; no regresamos ese comportamiento).
  const sumaPorNaturaleza = (excluir: string[]) =>
    egresosPorNaturaleza
      .filter((g) => !excluir.includes(g.naturaleza ?? ""))
      .reduce((s, g) => s + Number(g._sum.subtotal ?? 0), 0);
  const egresosCfdis = sumaPorNaturaleza(["INVERSION", "SIN_EFECTOS"]);
  const inversionesExcluidas = egresosPorNaturaleza.find((g) => g.naturaleza === "INVERSION")?._sum.subtotal ?? 0;
  const sinEfectosExcluidos = egresosPorNaturaleza.find((g) => g.naturaleza === "SIN_EFECTOS")?._sum.subtotal ?? 0;
  // 69-B: monto excluido por proveedores definitivos (ya descontado de egresosCfdis).
  const efosExcluidos = efosBloqueados.size > 0
    ? (await prisma.invoice.aggregate({
        where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: yearStart, lte: yearEnd }, customer: { rfc: { in: [...efosBloqueados] } } },
        _sum: { subtotal: true }, _count: { id: true },
      }))
    : null;
  // Deducción de inversiones del ejercicio: del registro de activo fijo, salvo
  // que el contador la sobreescriba por query param.
  const depreciacionRegistro = registroDepreciacion.totalDepreciacionEjercicio;
  const sueldos = Number(nominaAgg._sum.totalPercepciones ?? 0);
  const imssPatronal = Number(nominaAgg._sum.imssPatronal ?? 0);
  const ptuPagado = Number(nominaAgg._sum.ptu ?? 0);
  // Dedupe per periodo: prefer the dedicated ISR_PROVISIONAL row, fall back to a
  // legacy folded IVA_MENSUAL row, so imported and live-saved ISR are each counted once.
  const isrProvTotal = sumIsrPagar(isrProvisionalesAgg);

  // Tipo persona from RFC length
  const tipoPersona = company.rfc.length === 12 ? "PM" : "PF";

  // ── Build input with DB data + manual overrides from query params ──
  const input: DeclaracionAnualInput = {
    ejercicio,
    tipoPersona: tipoPersona as "PM" | "PF",
    regimenFiscal: company.regimenFiscal,
    ingresosPorCfdis: ingresosCfdis,
    otrosIngresos: parseFloat(searchParams.get("otrosIngresos") ?? "0"),
    ingresosAsimilados,
    comprasPorCfdis: egresosCfdis,
    sueldosYSalarios: sueldos,
    cuotasImssPatronal: imssPatronal,
    aportacionesInfonavitSar: parseFloat(searchParams.get("aportacionesInfonavitSar") ?? "0"),
    // Default: depreciación calculada del registro de activo fijo; el contador
    // puede sobreescribirla con ?depreciacion=.
    depreciacion: searchParams.has("depreciacion")
      ? parseFloat(searchParams.get("depreciacion") ?? "0")
      : depreciacionRegistro,
    otrasDeduccionesAutorizadas: parseFloat(searchParams.get("otrasDeduccionesAutorizadas") ?? "0"),
    ptuPagado,
    ajusteInflacionAcumulable: parseFloat(searchParams.get("ajusteInflacionAcumulable") ?? "0"),
    ajusteInflacionDeducible: parseFloat(searchParams.get("ajusteInflacionDeducible") ?? "0"),
    // Default: pérdidas pendientes actualizadas del ledger (Art. 57); overridable.
    perdidasEjerciciosAnteriores: searchParams.has("perdidasAnteriores")
      ? parseFloat(searchParams.get("perdidasAnteriores") ?? "0")
      : perdidasDisp.total,
    isrPagadoProvisionales: isrProvTotal,
    isrRetenidoPorTerceros: parseFloat(searchParams.get("isrRetenidoPorTerceros") ?? "0"),
    isrRetenidoAsimilados,
  };

  const result = calcularDeclaracionAnual(input);

  return NextResponse.json({
    company: { rfc: company.rfc, razonSocial: company.razonSocial, regimenFiscal: company.regimenFiscal },
    ...result,
    // Sources for transparency
    dataSources: {
      ingresosCfdis: { count: "Facturas emitidas del ejercicio", monto: ingresosCfdis },
      egresosCfdis: { count: "Gastos deducibles (excl. inversión y sin efectos)", monto: egresosCfdis },
      sueldos: { count: "Nómina del ejercicio", monto: sueldos },
      asimilados: { count: "Asimilados a salarios recibidos (Art. 94)", monto: ingresosAsimilados },
      isrRetenidoAsimilados: { count: "ISR que te retuvieron por asimilados (acreditable)", monto: isrRetenidoAsimilados },
      imssPatronal: { monto: imssPatronal },
      ptu: { monto: ptuPagado },
      isrProvisionales: { monto: isrProvTotal },
      // Deducibilidad por naturaleza (Fase 2b):
      depreciacionInversiones: {
        count: `${registroDepreciacion.activos.length} activo(s) en el registro`,
        monto: depreciacionRegistro,
        sobreescritoManual: searchParams.has("depreciacion"),
      },
      inversionesExcluidas: { count: "CFDI de inversión (se deducen vía depreciación)", monto: inversionesExcluidas },
      sinEfectosExcluidos: { count: "CFDI sin efectos fiscales (no deducible)", monto: sinEfectosExcluidos },
      efosExcluidos: efosExcluidos
        ? { count: `${efosExcluidos._count.id} CFDI(s) de proveedor 69-B definitivo (no deducible, Art. 69-B)`, monto: efosExcluidos._sum.subtotal ?? 0 }
        : { count: "Sin proveedores 69-B definitivos", monto: 0 },
    },
    existingDeclaration: existingAnual ? {
      id: existingAnual.id,
      status: existingAnual.status,
      isHistorical: existingAnual.isHistorical,
    } : null,
    // Amortización de pérdidas fiscales (Art. 57): pendientes actualizadas a
    // junio del ejercicio. `algunaIncompleta` = faltó algún INPC (cae a nominal).
    perdidasFiscales: {
      disponible: perdidasDisp.total,
      detalles: perdidasDisp.detalles,
      algunaIncompleta: perdidasDisp.algunaIncompleta,
      sobreescritoManual: searchParams.has("perdidasAnteriores"),
    },
  });
}

// POST /api/declaracion-anual — save the annual declaration
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, ejercicio, result, status, manualOverrides } = body;

  if (!companyId || !ejercicio) {
    return NextResponse.json({ error: "companyId y ejercicio requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const periodo = String(ejercicio);

  // Upsert the annual declaration
  const existing = await prisma.taxDeclaration.findFirst({
    where: { companyId, tipo: "DECLARACION_ANUAL", periodo },
  });

  const data = {
    status: status ?? "CALCULATED",
    isrIngresos: result?.totalIngresos ?? null,
    isrDeducciones: result?.totalDeducciones ?? null,
    isrBaseGravable: result?.resultadoFiscal ?? null,
    isrTasa: result?.tasaIsr ?? null,
    isrPagar: result?.isrAPagar ?? null,
    isrCoeficienteUtilidad: result?.coeficienteUtilidad ?? null,
  };

  let declaration;
  if (existing) {
    declaration = await prisma.taxDeclaration.update({
      where: { id: existing.id },
      data,
    });
  } else {
    declaration = await prisma.taxDeclaration.create({
      data: {
        companyId,
        tipo: "DECLARACION_ANUAL",
        periodo,
        ...data,
      },
    });
  }

  // Update company coeficiente for next year's provisionales
  if (result?.coeficienteUtilidad != null) {
    await prisma.company.update({
      where: { id: companyId },
      data: {
        coeficienteUtilidad: result.coeficienteUtilidad,
        coeficienteAnio: ejercicio + 1, // applies to NEXT year's provisionales
      },
    });
  }

  // ── Ledger de pérdidas fiscales (Art. 57) ─────────────────────────────────
  // Idempotente por ejercicio: (1) amortiza FIFO contra la utilidad, tocando sólo
  // las pérdidas aún no aplicadas en este ejercicio (guard ultimoEjercicioAplicado);
  // (2) si el ejercicio cerró en pérdida, la registra con su primera actualización.
  // Limitación v1: re-guardar el MISMO ejercicio no re-aplica (no doble-descuenta);
  // si cambia la utilidad en un re-guardado, el saldo no se recalcula.
  const utilidadOPerdida = typeof result?.utilidadOPerdidaFiscal === "number"
    ? result.utilidadOPerdidaFiscal
    : null;
  if (utilidadOPerdida != null) {
    const ejer = Number(ejercicio);
    await prisma.$transaction(async (tx) => {
      const records = await tx.perdidaFiscal.findMany({ where: { companyId } });
      const aplicables = records.filter((r) => (r.ultimoEjercicioAplicado ?? 0) < ejer);
      const ap = aplicarPerdidas(
        aplicables.map((p) => ({
          ejercicioOrigen: p.ejercicioOrigen,
          montoOriginal: Number(p.montoOriginal),
          saldoActualizado: Number(p.saldoActualizado),
          mesUltimaActualizacion: p.mesUltimaActualizacion,
          agotada: p.agotada,
          ultimoEjercicioAplicado: p.ultimoEjercicioAplicado,
        })),
        Math.max(0, utilidadOPerdida),
        ejer
      );
      for (const s of ap.saldosNuevos) {
        await tx.perdidaFiscal.update({
          where: { companyId_ejercicioOrigen: { companyId, ejercicioOrigen: s.ejercicioOrigen } },
          data: {
            saldoActualizado: s.saldoActualizado,
            mesUltimaActualizacion: s.mesUltimaActualizacion,
            agotada: s.agotada,
            ultimoEjercicioAplicado: ejer,
          },
        });
      }
      // Pérdida generada este ejercicio → con primera actualización (jul→dic).
      if (utilidadOPerdida < 0) {
        const montoOriginal = Math.round(-utilidadOPerdida * 100) / 100;
        const pa = primeraActualizacion(montoOriginal, ejer);
        await tx.perdidaFiscal.upsert({
          where: { companyId_ejercicioOrigen: { companyId, ejercicioOrigen: ejer } },
          create: {
            companyId,
            ejercicioOrigen: ejer,
            montoOriginal,
            saldoActualizado: pa.saldoActualizado,
            mesUltimaActualizacion: pa.mesUltimaActualizacion,
            origen: "CALCULADA",
          },
          update: {
            montoOriginal,
            saldoActualizado: pa.saldoActualizado,
            mesUltimaActualizacion: pa.mesUltimaActualizacion,
            origen: "CALCULADA",
          },
        });
      }
    });
  }

  return NextResponse.json({ ok: true, declaration });
}
