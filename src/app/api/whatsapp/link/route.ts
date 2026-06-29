import { NextResponse } from "next/server";
import { requireUser, withAuthz } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { startLink } from "@/lib/whatsapp/linking";
import { twilioConfigured } from "@/lib/whatsapp/twilio";
import { listAccessibleCompanies, normalizePhone } from "@/lib/whatsapp/identity";

export const runtime = "nodejs";

/**
 * GET — state for the WhatsApp settings UI: the user's links, whether the
 * channel is configured on the server, the current daily-digest preference,
 * and how many companies the user can reach (for despacho-only affordances).
 */
export const GET = withAuthz(async (req: Request) => {
  const user = await requireUser(req);
  const [links, companies] = await Promise.all([
    prisma.whatsappLink.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        phoneE164: true,
        verifiedAt: true,
        createdAt: true,
        digestOptIn: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    listAccessibleCompanies(user.id),
  ]);

  const verified = links.find((l) => l.verifiedAt);
  return NextResponse.json({
    links,
    available: twilioConfigured(),
    companyCount: companies.length,
    digestOptIn: verified?.digestOptIn ?? false,
  });
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

/**
 * PATCH { digestOptIn } — persists the daily-digest preference on the user's
 * verified links. Only meaningful for despacho operators (multiple companies);
 * the digest cron itself is a separate future build.
 */
export const PATCH = withAuthz(async (req: Request) => {
  const user = await requireUser(req);
  const { digestOptIn } = (await req.json()) as { digestOptIn?: boolean };
  if (typeof digestOptIn !== "boolean") {
    return NextResponse.json(
      { error: "digestOptIn debe ser booleano" },
      { status: 400 }
    );
  }

  await prisma.whatsappLink.updateMany({
    where: { userId: user.id, verifiedAt: { not: null } },
    data: { digestOptIn },
  });
  return NextResponse.json({ ok: true, digestOptIn });
});

/** DELETE { phone } — removes one of the user's links (unlink the number). */
export const DELETE = withAuthz(async (req: Request) => {
  const user = await requireUser(req);
  const { phone } = (await req.json().catch(() => ({}))) as { phone?: string };
  if (!phone) {
    return NextResponse.json({ error: "phone es requerido" }, { status: 400 });
  }

  // Scope the delete to the caller's own rows so a number can't be unlinked
  // from another account.
  await prisma.whatsappLink.deleteMany({
    where: { userId: user.id, phoneE164: normalizePhone(phone) },
  });
  return NextResponse.json({ ok: true });
});
