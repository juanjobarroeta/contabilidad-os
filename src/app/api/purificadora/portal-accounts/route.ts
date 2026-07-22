import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

// GET /api/purificadora/portal-accounts?companyId=xxx
// Cuentas de portal activadas (para pintar el estado en la página Clientes).
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const cuentas = await prisma.purifPortalAccount.findMany({
    where: { companyId },
    select: {
      id: true,
      customerId: true,
      email: true,
      activo: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });
  return NextResponse.json(cuentas);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  customerId: z.string().min(1),
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8, "Mínimo 8 caracteres").max(200),
});

// POST /api/purificadora/portal-accounts — «Activar portal» para un cliente.
// Una cuenta por cliente; el email es único entre cuentas de portal.
export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Datos inválidos";
    return NextResponse.json({ error: first }, { status: 400 });
  }
  const { companyId, customerId, email, password } = parsed.data;

  const { user: actor } = await requireWriter(companyId, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { companyId: true, razonSocial: true },
  });
  if (!customer || customer.companyId !== companyId) {
    return NextResponse.json({ error: "Cliente inválido" }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const cuenta = await prisma.purifPortalAccount.create({
      data: { companyId, customerId, email, passwordHash },
      select: { id: true, customerId: true, email: true, activo: true, createdAt: true },
    });
    registrarBitacora({
      companyId,
      userId: actor.id,
      actorEmail: actor.email,
      accion: "portal.activar",
      entidad: "PurifPortalAccount",
      entidadId: cuenta.id,
      detalle: { customerId, email, cliente: customer.razonSocial },
    });
    return NextResponse.json(cuenta, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Ese cliente ya tiene portal, o el correo ya está usado por otra cuenta de portal" },
      { status: 409 }
    );
  }
});
