import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/impuestos?companyId=xxx&month=4&year=2026
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const month = parseInt(searchParams.get("month") ?? "");
  const year = parseInt(searchParams.get("year") ?? "");

  if (!companyId || isNaN(month) || isNaN(year)) {
    return NextResponse.json({ error: "companyId, month y year son requeridos" }, { status: 400 });
  }

  // Verify membership
  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: session.user.id, companyId } },
  });
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  // Period boundaries
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 1); // exclusive

  // Facturas emitidas (INGRESO) timbradas en el período
  const facturasEmitidas = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: "INGRESO",
      status: "STAMPED",
      fecha: { gte: from, lt: to },
    },
    include: {
      customer: { select: { razonSocial: true, rfc: true } },
      taxes: true,
    },
    orderBy: { fecha: "asc" },
  });

  // Facturas de egresos (EGRESO) timbradas en el período — base para IVA acreditable
  const facturasEgresos = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: "EGRESO",
      status: "STAMPED",
      fecha: { gte: from, lt: to },
    },
    include: {
      customer: { select: { razonSocial: true, rfc: true } },
      taxes: true,
    },
    orderBy: { fecha: "asc" },
  });

  // IVA trasladado = sum of IVA taxes on INGRESO invoices
  // If no tax records, fall back to totalImpuestos field
  const ivaTrasladadoTotal = facturasEmitidas.reduce((sum, inv) => {
    const ivaTaxes = inv.taxes.filter((t) => t.tipo === "IVA" && !t.retencion);
    if (ivaTaxes.length > 0) {
      return sum + ivaTaxes.reduce((s, t) => s + t.importe, 0);
    }
    return sum + (inv.totalImpuestos ?? 0);
  }, 0);

  // IVA retenido (by clients on our invoices — reduces what we owe)
  const ivaRetenidoPorClientes = facturasEmitidas.reduce((sum, inv) => {
    const ret = inv.taxes.filter((t) => t.tipo === "IVA" && t.retencion);
    return sum + ret.reduce((s, t) => s + t.importe, 0);
  }, 0);

  // IVA acreditable = IVA on EGRESO invoices (gastos deducibles)
  const ivaAcreditable = facturasEgresos.reduce((sum, inv) => {
    const ivaTaxes = inv.taxes.filter((t) => t.tipo === "IVA" && !t.retencion);
    if (ivaTaxes.length > 0) {
      return sum + ivaTaxes.reduce((s, t) => s + t.importe, 0);
    }
    return sum + (inv.totalImpuestos ?? 0);
  }, 0);

  // IVA a cargo = trasladado - retenido por clientes - acreditable
  const ivaACargo = ivaTrasladadoTotal - ivaRetenidoPorClientes - ivaAcreditable;
  const ivaSaldoFavor = ivaACargo < 0 ? Math.abs(ivaACargo) : 0;
  const ivaPagar = ivaACargo > 0 ? ivaACargo : 0;

  // ISR provisional — simplified estimate
  const ingresosNetos = facturasEmitidas.reduce((s, inv) => s + inv.subtotal, 0);
  const gastos = facturasEgresos.reduce((s, inv) => s + inv.subtotal, 0);
  const baseGravable = Math.max(0, ingresosNetos - gastos);

  // Simplified ISR: 30% for personas morales (SAT tariff aplicable)
  // For RESICO (simplified trust): ranges from 1% to 2.5% on ingresos
  // We flag it as "estimate" — not a substitute for actual SAT filing
  const isrTasa = 0.30;
  const isrEstimado = baseGravable * isrTasa;

  // Fetch existing saved declaration if any
  const periodo = `${year}-${String(month).padStart(2, "0")}`;
  const declaracionGuardada = await prisma.taxDeclaration.findFirst({
    where: { companyId, tipo: "IVA_MENSUAL", periodo },
  });

  return NextResponse.json({
    periodo,
    month,
    year,
    iva: {
      trasladado: ivaTrasladadoTotal,
      retenidoPorClientes: ivaRetenidoPorClientes,
      acreditable: ivaAcreditable,
      pagar: ivaPagar,
      saldoFavor: ivaSaldoFavor,
    },
    isr: {
      ingresos: ingresosNetos,
      gastos,
      baseGravable,
      tasa: isrTasa,
      estimado: isrEstimado,
    },
    facturas: facturasEmitidas.map((inv) => ({
      id: inv.id,
      uuid: inv.uuid,
      fecha: inv.fecha,
      cliente: inv.customer?.razonSocial ?? "—",
      rfc: inv.customer?.rfc ?? "—",
      subtotal: inv.subtotal,
      iva: inv.totalImpuestos,
      total: inv.total,
    })),
    declaracionGuardada: declaracionGuardada
      ? { id: declaracionGuardada.id, status: declaracionGuardada.status }
      : null,
  });
}

// POST /api/impuestos — save/update declaration
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, periodo, tipo, ivaData, isrData, status } = body;

  if (!companyId || !periodo || !tipo) {
    return NextResponse.json({ error: "Datos incompletos" }, { status: 400 });
  }

  // Verify membership
  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: session.user.id, companyId } },
  });
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const declarationData = {
    status: status ?? "CALCULATED",
    ivaTrasladadoCobrado: ivaData?.trasladado ?? null,
    ivaAcreditableGastado: ivaData?.acreditable ?? null,
    ivaSaldoFavor: ivaData?.saldoFavor ?? null,
    ivaPagar: ivaData?.pagar ?? null,
    isrIngresos: isrData?.ingresos ?? null,
    isrDeducciones: isrData?.gastos ?? null,
    isrBaseGravable: isrData?.baseGravable ?? null,
    isrTasa: isrData?.tasa ?? null,
    isrPagar: isrData?.estimado ?? null,
  };

  const existing = await prisma.taxDeclaration.findFirst({
    where: { companyId, tipo, periodo },
  });

  const declaration = existing
    ? await prisma.taxDeclaration.update({ where: { id: existing.id }, data: declarationData })
    : await prisma.taxDeclaration.create({ data: { companyId, tipo, periodo, ...declarationData } });

  return NextResponse.json(declaration);
}
