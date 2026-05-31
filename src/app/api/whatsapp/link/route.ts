import { NextResponse } from "next/server";
import { requireUser, withAuthz } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { startLink } from "@/lib/whatsapp/linking";
import { twilioConfigured } from "@/lib/whatsapp/twilio";

export const runtime = "nodejs";

/** GET — list the current user's WhatsApp links (for the settings UI). */
export const GET = withAuthz(async (req: Request) => {
  const user = await requireUser(req);
  const links = await prisma.whatsappLink.findMany({
    where: { userId: user.id },
    select: { id: true, phoneE164: true, verifiedAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ links });
});

/** POST { phone } — start linking: sends a 6-digit code over WhatsApp. */
export const POST = withAuthz(async (req: Request) => {
  if (!twilioConfigured()) {
    return NextResponse.json(
      { error: "WhatsApp no está configurado en el servidor" },
      { status: 503 }
    );
  }

  const user = await requireUser(req);
  const { phone } = (await req.json()) as { phone?: string };
  if (!phone) {
    return NextResponse.json({ error: "phone es requerido" }, { status: 400 });
  }

  const result = await startLink(user.id, phone);
  if (!result.ok) {
    const status = result.reason === "taken" ? 409 : 502;
    const error =
      result.reason === "taken"
        ? "Ese número ya está vinculado a otra cuenta"
        : "No se pudo enviar el código por WhatsApp";
    return NextResponse.json({ error }, { status });
  }
  return NextResponse.json({ ok: true });
});
