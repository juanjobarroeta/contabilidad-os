import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { esAdminPlataforma } from "@/lib/billing/admin-plataforma";
import {
  activarCodigoDescuento,
  crearCodigoDescuento,
  listarCodigosDescuento,
  type NuevoCodigoInput,
} from "@/lib/billing/codigos-descuento";

// ─────────────────────────────────────────────────────────────────────────────
// Códigos de descuento (SOLO admin de plataforma — PLATFORM_ADMIN_EMAILS).
//   GET    → lista los últimos códigos con su estado y canjes.
//   POST   → crea coupon + promotion code en Stripe según la negociación.
//   PATCH  → { id, activo } desactiva/reactiva un código (no afecta canjes hechos).
// El cliente escribe el código en la pantalla de pago de Stripe (el checkout
// ya envía allow_promotion_codes). Sesión web a propósito: es una acción de
// operación del negocio, no de servicio.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

async function adminEmail(): Promise<string | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  // El correo se lee de la DB (autoritativo), no del token de sesión.
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  if (!user?.email || !esAdminPlataforma(user.email)) return null;
  return user.email;
}

export async function GET() {
  const email = await adminEmail();
  if (!email) return NextResponse.json({ error: "No autorizado" }, { status: 403 });

  const out = await listarCodigosDescuento();
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ codigos: out.codigos });
}

export async function POST(req: Request) {
  const email = await adminEmail();
  if (!email) return NextResponse.json({ error: "No autorizado" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as NuevoCodigoInput | null;
  if (!body) return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 });

  const out = await crearCodigoDescuento(body, email);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ codigo: out.codigo }, { status: 201 });
}

export async function PATCH(req: Request) {
  const email = await adminEmail();
  if (!email) return NextResponse.json({ error: "No autorizado" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { id?: string; activo?: boolean } | null;
  if (!body?.id || typeof body.activo !== "boolean")
    return NextResponse.json({ error: "Se requiere id y activo (true/false)." }, { status: 400 });

  const out = await activarCodigoDescuento(body.id, body.activo);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ codigo: out.codigo });
}
