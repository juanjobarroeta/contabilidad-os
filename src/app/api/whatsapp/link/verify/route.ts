import { NextResponse } from "next/server";
import { requireUser, withAuthz } from "@/lib/authz";
import { verifyCode } from "@/lib/whatsapp/linking";

export const runtime = "nodejs";

/** POST { phone, code } — completes linking by verifying the 6-digit code. */
export const POST = withAuthz(async (req: Request) => {
  const user = await requireUser(req);
  const { phone, code } = (await req.json()) as { phone?: string; code?: string };
  if (!phone || !code) {
    return NextResponse.json({ error: "phone y code son requeridos" }, { status: 400 });
  }

  const result = await verifyCode(user.id, phone, code);
  if (!result.ok) {
    const messages: Record<string, string> = {
      not_found: "No hay un código pendiente para ese número",
      expired: "El código expiró, solicita uno nuevo",
      locked: "Demasiados intentos, solicita un código nuevo",
      mismatch: "Código incorrecto",
    };
    return NextResponse.json({ error: messages[result.reason] }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
});
