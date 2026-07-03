import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { stampPayrollRun } from "@/lib/nomina/payroll-run";
import { registrarBitacora } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

// POST /api/nomina/run/[id]/stamp
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const run = await prisma.payrollRun.findUnique({ where: { id }, select: { companyId: true } });
  if (!run) return NextResponse.json({ error: "Corrida no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, run.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED).
  const gate = await gateEscritura(session.user.id);
  if (gate) return gate;

  const result = await stampPayrollRun(id);

  // Bitácora de seguridad: timbrado de nómina (fire-and-forget).
  if (result.ok || result.stamped > 0) {
    registrarBitacora({
      companyId: run.companyId,
      userId: session.user.id,
      actorEmail: session.user.email ?? null,
      accion: "nomina.timbrar",
      entidad: "PayrollRun",
      entidadId: id,
      detalle: { stamped: result.stamped, total: result.total, errores: result.errors.length },
      req,
    });
  }

  return NextResponse.json(result);
}
