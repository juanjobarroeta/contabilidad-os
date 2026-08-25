import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";
import { createPayrollRun } from "@/lib/nomina/payroll-run";

// GET /api/nomina/run?companyId=xxx
// Autz: sesión web O token de servicio (Bearer) — ZionX espeja las corridas.
export async function GET(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const runs = await prisma.payrollRun.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { items: true } } },
  });

  // Sumas por corrida que la lista necesita para leerse como papel de trabajo
  // (ISR retenido, IMSS obrero + INFONAVIT) y el pendiente operativo (recibos
  // sin CFDI timbrado en corridas que ya no son borrador). Una consulta
  // agregada para todas las corridas, no una por renglón. Campos ADITIVOS:
  // ZionX espeja este arreglo y sólo lee los que ya conocía.
  const porRun = await prisma.payrollItem.groupBy({
    by: ["payrollRunId"],
    where: { payrollRun: { companyId } },
    _sum: { isrRetenido: true, imssObrero: true, infonavit: true },
  });
  const sinCfdi = await prisma.payrollItem.groupBy({
    by: ["payrollRunId"],
    where: { payrollRun: { companyId, status: { notIn: ["DRAFT"] } }, cfdiUuid: null },
    _count: { _all: true },
  });
  const sumasBy = new Map(porRun.map((r) => [r.payrollRunId, r._sum]));
  const sinCfdiBy = new Map(sinCfdi.map((r) => [r.payrollRunId, r._count._all]));

  return NextResponse.json(
    runs.map((r) => {
      const s = sumasBy.get(r.id);
      return {
        ...r,
        isrRetenido: s?.isrRetenido ?? 0,
        imssObrero: s?.imssObrero ?? 0,
        infonavit: s?.infonavit ?? 0,
        recibosSinTimbrar: sinCfdiBy.get(r.id) ?? 0,
      };
    })
  );
}

// POST /api/nomina/run
// Autz: sesión web O token de servicio (Bearer) — JCPT crea la corrida desde
// su roster presupuestado; la autorización por empresa es la misma
// (membresía efectiva, VIEWER no escribe).
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const body = await req.json();
  const { companyId, tipo, periodoInicio, periodoFin, fechaPago, diasPagados, employeeIds, ...extra } = body;

  if (!companyId || !tipo || !periodoInicio || !periodoFin || !fechaPago || !diasPagados) {
    return NextResponse.json({ error: "Faltan campos requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const result = await createPayrollRun({
    companyId,
    tipo,
    periodoInicio: new Date(periodoInicio),
    periodoFin: new Date(periodoFin),
    fechaPago: new Date(fechaPago),
    diasPagados: Number(diasPagados),
    employeeIds: employeeIds?.length ? employeeIds : undefined,
    diasAguinaldo: extra.diasAguinaldo ? Number(extra.diasAguinaldo) : undefined,
    fechaCorte: extra.fechaCorte ? new Date(extra.fechaCorte) : undefined,
    diasVacacionesTomar: extra.diasVacacionesTomar ? Number(extra.diasVacacionesTomar) : undefined,
    primaVacacionalPct: extra.primaVacacionalPct ? Number(extra.primaVacacionalPct) : undefined,
    utilidadFiscalGravable: extra.utilidadFiscalGravable ? Number(extra.utilidadFiscalGravable) : undefined,
    topeSalarioPtu: extra.topeSalarioPtu ? Number(extra.topeSalarioPtu) : undefined,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json(result, { status: 201 });
}
