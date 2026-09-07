/**
 * POST /api/salameria/tienda/registro — alta de cuenta desde la tienda.
 *
 * RUTA PÚBLICA: es el registro del comprador. Crea la cuenta al MENUDEO —sin
 * lista de mayoreo, sin crédito— y deja el token listo para seguir comprando.
 * Subirla a mayorista es una decisión de la empresa y se hace desde el ERP
 * (PATCH /api/salameria/cuentas/[id]); si el registro pudiera pedir su propia
 * lista de precios, cualquiera se daría precio de mayoreo.
 *
 * No pide RFC. Quien quiere factura la pide al pagar y ahí se crea el Customer;
 * exigir RFC para registrarse pierde a la mitad del menudeo en la primera
 * pantalla.
 *
 * RESPUESTA UNIFORME ante un correo ya registrado: 409 con el mismo texto
 * genérico. Un mensaje distinto convertiría el registro en un verificador de
 * quién es cliente.
 */

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { signSalTiendaToken } from "@/lib/api-token";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { tiendaPublica } from "@/lib/salameria/tienda";

const schema = z.object({
  companyId: z.string().min(1),
  email: z.string().email().max(160).transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8).max(200),
  nombre: z.string().min(1).max(120).transform((s) => s.trim()),
  telefono: z.string().max(30).nullable().optional(),
});

export async function POST(req: Request) {
  const limite = checkRateLimit(`sal-registro:ip:${getClientIp(req)}`, {
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!limite.ok) {
    return NextResponse.json(
      { error: "Demasiados registros. Intenta más tarde." },
      { status: 429, headers: { "Retry-After": String(limite.retryAfterSeconds ?? 60) } }
    );
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, email, password, nombre, telefono } = parsed.data;

  const config = await tiendaPublica(companyId);
  if (!config) {
    return NextResponse.json({ error: "Tienda no disponible" }, { status: 404 });
  }

  const existe = await prisma.salCuenta.findUnique({
    where: { companyId_email: { companyId, email } },
    select: { id: true },
  });
  if (existe) {
    return NextResponse.json(
      { error: "No se pudo crear la cuenta con ese correo. ¿Ya tienes una? Inicia sesión." },
      { status: 409 }
    );
  }

  const cuenta = await prisma.salCuenta.create({
    data: {
      companyId,
      email,
      nombre,
      telefono: telefono ?? null,
      passwordHash: await bcrypt.hash(password, 10),
      // Menudeo: sin lista propia ve la pública, y sin crédito paga de contado.
      listaId: null,
      diasCredito: 0,
      limiteCredito: 0,
    },
    select: { id: true, email: true, nombre: true, telefono: true, companyId: true },
  });

  const token = await signSalTiendaToken({
    sub: cuenta.id,
    companyId: cuenta.companyId,
    customerId: null,
    email: cuenta.email,
  });

  return NextResponse.json(
    {
      token,
      cuenta: {
        id: cuenta.id,
        email: cuenta.email,
        nombre: cuenta.nombre,
        telefono: cuenta.telefono,
        mayoreo: false,
        lista: null,
        cliente: null,
        diasCredito: 0,
      },
    },
    { status: 201 }
  );
}
