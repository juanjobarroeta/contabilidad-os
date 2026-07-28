import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/onboarding/contexto — le dice al wizard de onboarding si el usuario
// llegó por una INVITACIÓN (su despacho nació con condiciones predefinidas):
// en ese caso el paso "Plan" no debe vender precios — el plan ya está incluido.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const dm = await prisma.despachoMember.findUnique({
    where: { userId: session.user.id },
    select: {
      despacho: { select: { name: true, defaultTier: true, maxEmpresas: true } },
    },
  });
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { subscriptionStatus: true },
  });

  // defaultTier != null ⇔ el despacho lo creó una invitación de onboarding.
  const invitado = dm?.despacho?.defaultTier != null;
  return NextResponse.json({
    invitado,
    despachoNombre: dm?.despacho?.name ?? null,
    sinCargo: invitado && user?.subscriptionStatus === "ACTIVE",
    syntage: invitado ? dm!.despacho!.defaultTier !== "ASISTENTE" : null,
    maxEmpresas: dm?.despacho?.maxEmpresas ?? null,
  });
}
