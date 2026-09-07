/**
 * GET  /api/salameria/cuentas?companyId=... [&q=]
 * POST /api/salameria/cuentas
 *
 * Las cuentas de la tienda, administradas desde el ERP: es donde se le asigna
 * a una pastelería su lista de mayoreo, su crédito y su RFC para facturar.
 *
 * El `passwordHash` NUNCA sale de aquí. Al crear una cuenta desde el ERP se
 * fija una contraseña temporal que el mayorista cambia al entrar — mandarle su
 * contraseña de vuelta al administrador la convierte en una credencial
 * compartida.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const SELECT_PUBLICO = {
  id: true,
  email: true,
  nombre: true,
  telefono: true,
  customerId: true,
  listaId: true,
  diasCredito: true,
  limiteCredito: true,
  activa: true,
  ultimoLogin: true,
  createdAt: true,
} as const;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "SALAMERIA", req);

  const q = searchParams.get("q");

  const cuentas = await prisma.salCuenta.findMany({
    where: {
      companyId,
      ...(q
        ? {
            OR: [
              { email: { contains: q, mode: "insensitive" as const } },
              { nombre: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: [{ activa: "desc" }, { nombre: "asc" }],
    select: {
      ...SELECT_PUBLICO,
      lista: { select: { id: true, nombre: true, tipo: true } },
      customer: { select: { id: true, razonSocial: true, rfc: true } },
      _count: { select: { pedidos: true } },
    },
  });

  return NextResponse.json(cuentas);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  email: z.string().email().max(160).transform((v) => v.trim().toLowerCase()),
  password: z.string().min(8).max(200),
  nombre: z.string().max(120).nullable().optional(),
  telefono: z.string().max(30).nullable().optional(),
  customerId: z.string().nullable().optional(),
  listaId: z.string().nullable().optional(),
  diasCredito: z.number().int().min(0).max(180).default(0),
  limiteCredito: z.number().min(0).default(0),
});

export const POST = withAuthz(async (req: Request) => {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, password, listaId, customerId, ...data } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "SALAMERIA", req);

  const existe = await prisma.salCuenta.findUnique({
    where: { companyId_email: { companyId, email: data.email } },
    select: { id: true },
  });
  if (existe) {
    return NextResponse.json(
      { error: "Ya existe una cuenta con ese correo" },
      { status: 409 }
    );
  }

  // Lista y cliente tienen que ser de ESTA empresa: sin la comprobación, un id
  // de otro tenant le daría a esta cuenta los precios (o el RFC) de aquél.
  if (listaId) {
    const lista = await prisma.salListaPrecio.findFirst({
      where: { id: listaId, companyId },
      select: { id: true },
    });
    if (!lista) {
      return NextResponse.json({ error: "Lista no encontrada" }, { status: 404 });
    }
  }
  if (customerId) {
    const cliente = await prisma.customer.findFirst({
      where: { id: customerId, companyId },
      select: { id: true },
    });
    if (!cliente) {
      return NextResponse.json({ error: "Cliente no encontrado" }, { status: 404 });
    }
  }

  const cuenta = await prisma.salCuenta.create({
    data: {
      companyId,
      ...data,
      listaId: listaId ?? null,
      customerId: customerId ?? null,
      passwordHash: await bcrypt.hash(password, 10),
    },
    select: SELECT_PUBLICO,
  });

  return NextResponse.json(cuenta, { status: 201 });
});
