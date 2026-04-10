import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { stampPayrollRun } from "@/lib/nomina/payroll-run";

type Params = { params: Promise<{ id: string }> };

// POST /api/nomina/run/[id]/stamp
export async function POST(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const run = await prisma.payrollRun.findUnique({ where: { id }, select: { companyId: true } });
  if (!run) return NextResponse.json({ error: "Corrida no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, run.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const result = await stampPayrollRun(id);
  return NextResponse.json(result);
}
