/**
 * POST /api/salameria/tienda/login — entrada del comprador a la tienda.
 *
 * Mismos límites anti credential-stuffing y respuestas uniformes que los
 * portales de automotriz y purificadora: nunca se distingue entre «ese correo
 * no existe» y «la contraseña está mal», porque hacerlo convierte el login en
 * un verificador de qué mayoristas le compran a la competencia.
 */

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { signSalTiendaToken } from "@/lib/api-token";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { tiendaPublica } from "@/lib/salameria/tienda";

const loginSchema = z.object({
  companyId: z.string().min(1),
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(1),
});

const WINDOW_MS = 15 * 60 * 1000;
const tooMany = (retry?: number) =>
  NextResponse.json(
    { error: "Demasiados intentos. Intenta de nuevo más tarde." },
    { status: 429, headers: { "Retry-After": String(retry ?? 60) } }
  );

export async function POST(req: Request) {
  const ipLimit = checkRateLimit(`sal-tienda:ip:${getClientIp(req)}`, {
    limit: 10,
    windowMs: WINDOW_MS,
  });
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfterSeconds);

  const parsed = loginSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Credenciales inválidas" }, { status: 400 });
  }
  const { companyId, email, password } = parsed.data;

  const emailLimit = checkRateLimit(`sal-tienda:email:${email}`, {
    limit: 5,
    windowMs: WINDOW_MS,
  });
  if (!emailLimit.ok) return tooMany(emailLimit.retryAfterSeconds);

  const config = await tiendaPublica(companyId);
  if (!config) {
    return NextResponse.json({ error: "Tienda no disponible" }, { status: 404 });
  }

  const cuenta = await prisma.salCuenta.findUnique({
    where: { companyId_email: { companyId, email } },
    include: {
      lista: { select: { id: true, nombre: true, tipo: true } },
      customer: { select: { razonSocial: true, rfc: true } },
    },
  });

  if (!cuenta || !cuenta.activa || !(await bcrypt.compare(password, cuenta.passwordHash))) {
    return NextResponse.json({ error: "Correo o contraseña incorrectos" }, { status: 401 });
  }

  const token = await signSalTiendaToken({
    sub: cuenta.id,
    companyId: cuenta.companyId,
    customerId: cuenta.customerId,
    email: cuenta.email,
  });

  await prisma.salCuenta.update({
    where: { id: cuenta.id },
    data: { ultimoLogin: new Date() },
  });

  return NextResponse.json({
    token,
    cuenta: {
      id: cuenta.id,
      email: cuenta.email,
      nombre: cuenta.nombre,
      telefono: cuenta.telefono,
      // Que la lista sea de mayoreo es lo que la tienda enseña como «Precios de
      // mayorista»; el descuento en sí no se expone.
      mayoreo: Boolean(cuenta.lista && cuenta.lista.tipo !== "MENUDEO"),
      lista: cuenta.lista?.nombre ?? null,
      cliente: cuenta.customer,
      diasCredito: cuenta.diasCredito,
    },
  });
}
