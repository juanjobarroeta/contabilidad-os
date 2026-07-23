import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { esAdminPlataforma } from "@/lib/billing/admin-plataforma";
import { registrarBitacora } from "@/lib/audit";

// DELETE /api/onboarding-invites/[id] — revoca una invitación PENDIENTE.
// Sólo admin de plataforma. Una ya ACEPTADA no se toca (el despacho ya existe).
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email || !esAdminPlataforma(email)) {
    return NextResponse.json({ error: "Sólo el admin de plataforma" }, { status: 403 });
  }

  const { id } = await params;
  const invite = await prisma.onboardingInvite.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!invite) return NextResponse.json({ error: "Invitación no encontrada" }, { status: 404 });
  if (invite.status !== "PENDING") {
    return NextResponse.json({ error: `La invitación ya está ${invite.status.toLowerCase()}` }, { status: 409 });
  }

  await prisma.onboardingInvite.update({ where: { id }, data: { status: "REVOKED" } });
  registrarBitacora({
    companyId: null,
    userId: null,
    actorEmail: email,
    accion: "onboarding-invite.revocar",
    entidad: "OnboardingInvite",
    entidadId: id,
    req,
  });
  return NextResponse.json({ ok: true });
}
