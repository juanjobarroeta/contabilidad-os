import { NextResponse } from "next/server";
import { requireUser, withAuthz } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { startLink, generateLinkCode, waMeLink, businessNumberE164 } from "@/lib/whatsapp/linking";
import { twilioConfigured } from "@/lib/whatsapp/twilio";
import { listAccessibleCompanies, normalizePhone } from "@/lib/whatsapp/identity";

/**
 * ¿Está configurada la plantilla de OTP? Si lo está, seguimos usando el flujo
 * legado (el negocio envía el código). Si NO (caso actual, pre-verificación de
 * Meta), el flujo por defecto es el deep-link: el usuario nos envía el código.
 */
function otpTemplateConfigured(): boolean {
  return Boolean(process.env.TWILIO_OTP_TEMPLATE_SID);
}

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
    // Cuando NO hay plantilla de OTP configurada, la app usa el flujo deep-link
    // (el usuario envía el código). La UI se adapta según esta bandera.
    templateFlow: otpTemplateConfigured(),
    companyCount: companies.length,
    digestOptIn: verified?.digestOptIn ?? false,
  });
});

/**
 * POST — inicia la vinculación.
 *   - Deep-link (por defecto, sin plantilla): genera un código de 6 dígitos que
 *     el usuario ENVÍA al número del negocio. Devuelve el código, el número y el
 *     enlace wa.me. No requiere teléfono (es desconocido hasta que el usuario
 *     escribe). Abre la ventana de 24h sin plantilla ni verificación de Meta.
 *   - OTP (legado, con plantilla): { phone } → envía el código al número.
 */
export const POST = withAuthz(async (req: Request) => {
  if (!twilioConfigured()) {
    return NextResponse.json(
      { error: "WhatsApp no está configurado en el servidor" },
      { status: 503 }
    );
  }

  const user = await requireUser(req);

  // Flujo deep-link (por defecto mientras no haya plantilla de OTP aprobada).
  if (!otpTemplateConfigured()) {
    const { code, expiresAt } = await generateLinkCode(user.id);
    const from = process.env.TWILIO_WHATSAPP_FROM!;
    return NextResponse.json({
      ok: true,
      mode: "deeplink",
      code,
      expiresAt,
      businessNumber: businessNumberE164(from),
      waMeUrl: waMeLink(from, code),
    });
  }

  // Flujo OTP (legado): requiere el teléfono.
  const { phone } = (await req.json().catch(() => ({}))) as { phone?: string };
  if (!phone) {
    return NextResponse.json({ error: "phone es requerido" }, { status: 400 });
  }

  const result = await startLink(user.id, phone);
  if (!result.ok) {
    const status = result.reason === "taken" ? 409 : 502;
    const error =
      result.reason === "taken"
        ? "Ese número ya está vinculado a otra cuenta"
        : result.reason === "template_required"
          ? "No pudimos enviar el código por WhatsApp todavía (falta configurar la plantilla de verificación). Escríbenos primero un mensaje por WhatsApp para abrir la conversación e inténtalo de nuevo, o contacta a soporte."
          : "No se pudo enviar el código por WhatsApp";
    return NextResponse.json({ error }, { status });
  }
  // Devolvemos la forma canónica (la que realmente guardamos y a la que enviamos
  // el código) para que la UI la muestre y el usuario confirme que es su número.
  return NextResponse.json({ ok: true, mode: "otp", phone: normalizePhone(phone) });
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
