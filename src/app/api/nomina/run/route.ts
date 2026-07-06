import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
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

  return NextResponse.json(runs);
}

// POST /api/nomina/run
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, tipo, periodoInicio, periodoFin, fechaPago, diasPagados, employeeIds, ...extra } = body;

  if (!companyId || !tipo || !periodoInicio || !periodoFin || !fechaPago || !diasPagados) {
    return NextResponse.json({ error: "Faltan campos requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
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
