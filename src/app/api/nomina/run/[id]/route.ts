import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

type Params = { params: Promise<{ id: string }> };

// GET /api/nomina/run/[id]
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const run = await prisma.payrollRun.findUnique({
    where: { id },
    include: {
      items: {
        include: { employee: { select: { nombre: true, apellidoPaterno: true, rfc: true } } },
      },
    },
  });

  if (!run) return NextResponse.json({ error: "Corrida no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, run.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  return NextResponse.json(run);
}

// DELETE /api/nomina/run/[id]
// Only DRAFT or CALCULATED runs can be deleted (not stamped — CFDIs already exist)
export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const run = await prisma.payrollRun.findUnique({
    where: { id },
    select: { id: true, companyId: true, status: true },
  });

  if (!run) return NextResponse.json({ error: "Corrida no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, run.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  if (run.status === "STAMPED" || run.status === "PAID") {
    return NextResponse.json(
      { error: "No se puede eliminar una corrida timbrada. Los CFDIs ya fueron emitidos ante el SAT." },
      { status: 400 }
    );
  }

  // Delete items first (cascade should handle it, but explicit for safety)
  await prisma.payrollItem.deleteMany({ where: { payrollRunId: id } });
  await prisma.payrollRun.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
