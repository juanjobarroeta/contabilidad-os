import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { calcularDeclaracionAnual, type DeclaracionAnualInput } from "@/lib/declaracion-anual";
import { sumIsrPagar } from "@/lib/isr-provisional";

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

  // ── Parallel data aggregation ──
  const [
    ingresosAgg,
    egresosAgg,
    nominaAgg,
    isrProvisionalesAgg,
    existingAnual,
  ] = await Promise.all([
    // Total CFDI ingresos for the year
    prisma.invoice.aggregate({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: yearStart, lte: yearEnd } },
      _sum: { subtotal: true, totalImpuestos: true },
    }),
    // Total CFDI egresos for the year
    prisma.invoice.aggregate({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: yearStart, lte: yearEnd } },
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
    }),
    // Check for existing saved annual declaration
    prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: "DECLARACION_ANUAL", periodo: String(ejercicio) },
    }),
  ]);

  const ingresosCfdis = ingresosAgg._sum.subtotal ?? 0;
  const egresosCfdis = egresosAgg._sum.subtotal ?? 0;
  const sueldos = nominaAgg._sum.totalPercepciones ?? 0;
  const imssPatronal = nominaAgg._sum.imssPatronal ?? 0;
  const ptuPagado = nominaAgg._sum.ptu ?? 0;
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
    comprasPorCfdis: egresosCfdis,
    sueldosYSalarios: sueldos,
    cuotasImssPatronal: imssPatronal,
    aportacionesInfonavitSar: parseFloat(searchParams.get("aportacionesInfonavitSar") ?? "0"),
    depreciacion: parseFloat(searchParams.get("depreciacion") ?? "0"),
    otrasDeduccionesAutorizadas: parseFloat(searchParams.get("otrasDeduccionesAutorizadas") ?? "0"),
    ptuPagado,
    ajusteInflacionAcumulable: parseFloat(searchParams.get("ajusteInflacionAcumulable") ?? "0"),
    ajusteInflacionDeducible: parseFloat(searchParams.get("ajusteInflacionDeducible") ?? "0"),
    perdidasEjerciciosAnteriores: parseFloat(searchParams.get("perdidasAnteriores") ?? "0"),
    isrPagadoProvisionales: isrProvTotal,
    isrRetenidoPorTerceros: parseFloat(searchParams.get("isrRetenidoPorTerceros") ?? "0"),
  };

  const result = calcularDeclaracionAnual(input);

  return NextResponse.json({
    company: { rfc: company.rfc, razonSocial: company.razonSocial, regimenFiscal: company.regimenFiscal },
    ...result,
    // Sources for transparency
    dataSources: {
      ingresosCfdis: { count: "Facturas emitidas del ejercicio", monto: ingresosCfdis },
      egresosCfdis: { count: "Facturas recibidas del ejercicio", monto: egresosCfdis },
      sueldos: { count: "Nómina del ejercicio", monto: sueldos },
      imssPatronal: { monto: imssPatronal },
      ptu: { monto: ptuPagado },
      isrProvisionales: { monto: isrProvTotal },
    },
    existingDeclaration: existingAnual ? {
      id: existingAnual.id,
      status: existingAnual.status,
      isHistorical: existingAnual.isHistorical,
    } : null,
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

  return NextResponse.json({ ok: true, declaration });
}
