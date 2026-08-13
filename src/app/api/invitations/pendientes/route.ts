import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/invitations/pendientes — invitaciones de cliente PENDIENTES para el
// correo de la sesión.
//
// Existe como red de rescate del onboarding: un invitado que se registró sin
// volver al enlace de su invitación cae al wizard, que le pide crear una
// empresa y contratar un plan — cuando su despacho ya paga la empresa a la que
// lo invitaron. Con esto el wizard puede decirle "a ti te invitaron, no
// necesitas nada de esto".
//
// NUNCA devuelve el token (sólo se guarda su hash; el enlace es el factor de
// posesión y viaja únicamente en el mensaje original del despacho). Por eso el
// rescate informa y orienta, pero aceptar sigue requiriendo el enlace.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  const invitaciones = await prisma.companyInvitation.findMany({
    where: {
      email: session.user.email.toLowerCase(),
      status: "PENDING",
      expiresAt: { gt: new Date() },
    },
    select: {
      company: { select: { razonSocial: true } },
      despacho: { select: { name: true } },
      createdAt: true,
      expiresAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    invitaciones.map((i) => ({
      empresa: i.company.razonSocial,
      despacho: i.despacho?.name ?? null,
      creadaEl: i.createdAt.toISOString().slice(0, 10),
      expiraEl: i.expiresAt.toISOString().slice(0, 10),
    }))
  );
}
