import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { registrarAceptaciones } from "@/lib/legal/aceptaciones";
import { DOCUMENTOS_CUENTA } from "@/lib/legal/documentos";
import { finDePrueba } from "@/lib/juridico/suscripcion";
import { reportError } from "@/lib/observability";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/juridico/registro — alta por cuenta propia de un despacho en Libra.
//
// Hasta aquí, entrar dependía de que nosotros creáramos la cuenta o de que un
// socio invitara. Esto abre la puerta: quien llega a la página se da de alta,
// su despacho nace en prueba y puede trabajar el mismo minuto.
//
// Sin tarjeta. Con aceptación EXPRESA de los Términos y el Aviso de Privacidad
// (clickwrap), cuya evidencia queda en LegalAcceptance: en un producto para
// abogados, el registro de esa aceptación es lo primero que alguien va a pedir.
// ─────────────────────────────────────────────────────────────────────────────
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  nombre: z.string().trim().min(2, "Falta tu nombre").max(120),
  email: z.string().email("Correo inválido").transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8, "La contraseña necesita al menos 8 caracteres").max(200),
  despacho: z.string().trim().max(120).optional(),
  aceptaTerminos: z.literal(true, { errorMap: () => ({ message: "Hay que aceptar los Términos y el Aviso de Privacidad" }) }),
});

export async function POST(req: Request) {
  const porIp = checkRateLimit(`juridico:registro:ip:${getClientIp(req)}`, { limit: 5, windowMs: 60 * 60 * 1000 });
  if (!porIp.ok) return NextResponse.json({ error: "Demasiados intentos. Vuelve a intentar más tarde." }, { status: 429, headers: { "Retry-After": String(porIp.retryAfterSeconds ?? 60) } });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos" }, { status: 400 });
  const { nombre, email, password, despacho, aceptaTerminos } = parsed.data;
  void aceptaTerminos;

  const previo = await prisma.user.findUnique({ where: { email }, select: { id: true, password: true } });
  // Una cuenta que ya existe no se pisa NUNCA: sería un secuestro de cuenta.
  if (previo?.password) return NextResponse.json({ error: "Ya hay una cuenta con ese correo. Entra con tu contraseña o pide que te restablezcan el acceso." }, { status: 409 });

  try {
    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.upsert({
      where: { email },
      // ACTIVE a propósito: el asiento jurídico no tiene empresa ni cargo, y un
      // TRIALING vencido le cerraría la puerta al token del satélite.
      create: { email, name: nombre, password: hash, accesoJuridico: true, emailVerified: new Date(), subscriptionStatus: "ACTIVE" },
      update: { name: nombre, password: hash, accesoJuridico: true, subscriptionStatus: "ACTIVE" },
      select: { id: true, email: true, name: true },
    });
    const d = await prisma.juridicoDespacho.create({
      data: {
        nombre: (despacho?.trim() || `Despacho de ${nombre}`).slice(0, 120),
        creadoPorUserId: user.id,
        plan: "prueba",
        pruebaHasta: finDePrueba(),
        miembros: { create: { userId: user.id, rol: "socio" } },
      },
      select: { id: true, nombre: true },
    });
    await registrarAceptaciones({
      userId: user.id,
      email: user.email,
      documentos: DOCUMENTOS_CUENTA.map((d) => d.documento),
      contexto: "signup",
      req,
    }).catch((e) => reportError(e, { ruta: "juridico/registro", paso: "aceptaciones", userId: user.id }));
    return NextResponse.json({ ok: true, despacho: d, email: user.email }, { status: 201 });
  } catch (e) {
    reportError(e, { ruta: "juridico/registro", email });
    return NextResponse.json({ error: "No se pudo crear la cuenta. Inténtalo de nuevo." }, { status: 500 });
  }
}
