import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";
import { recalcularPayrollRun } from "@/lib/nomina/payroll-run";

type Params = { params: Promise<{ id: string }> };

// POST /api/nomina/run/[id]/recalcular
// Recalcula la corrida (o un empleado, body { employeeId }) con el motor y las
// incidencias vigentes del periodo. Sólo corridas DRAFT/CALCULATED de la app;
// las timbradas no cambian (los CFDIs ya se emitieron).
export async function POST(req: Request, { params }: Params) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { id } = await params;
  const run = await prisma.payrollRun.findUnique({ where: { id }, select: { companyId: true } });
  if (!run) return NextResponse.json({ error: "Corrida no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(user.id, run.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  let employeeId: string | undefined;
  try {
    const body = await req.json();
    employeeId = typeof body?.employeeId === "string" ? body.employeeId : undefined;
  } catch {
    // Sin body: recalcular toda la corrida.
  }

  const result = await recalcularPayrollRun(id, employeeId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}
