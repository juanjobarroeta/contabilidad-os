import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  hashOnboardingToken,
  evaluarInvitacion,
  MOTIVO_INVITACION,
} from "@/lib/onboarding-invite";

// GET /api/onboarding-invites/preview?token=… — PÚBLICO (sin sesión).
// La página de signup lo llama para mostrar el banner de la invitación antes de
// registrarse. Revela SÓLO lo necesario (nombre del despacho + condiciones);
// nunca el token ni datos internos. La existencia se difumina detrás del hash.
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token")?.trim();
  if (!token) return NextResponse.json({ valida: false, motivo: "no_encontrada" }, { status: 200 });

  const invite = await prisma.onboardingInvite.findUnique({
    where: { tokenHash: hashOnboardingToken(token) },
    select: { despachoName: true, ownerNombre: true, tierEmpresas: true, sinCargo: true, maxEmpresas: true, status: true, expiresAt: true },
  });

  const estado = evaluarInvitacion(invite, new Date());
  if (!estado.ok) {
    return NextResponse.json({ valida: false, motivo: estado.motivo, mensaje: MOTIVO_INVITACION[estado.motivo] });
  }
  return NextResponse.json({
    valida: true,
    despachoName: invite!.despachoName,
    ownerNombre: invite!.ownerNombre,
    // Syntage on = tier distinto de ASISTENTE.
    syntage: invite!.tierEmpresas !== "ASISTENTE",
    sinCargo: invite!.sinCargo,
    maxEmpresas: invite!.maxEmpresas,
  });
}
