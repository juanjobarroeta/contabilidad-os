/**
 * POST /api/automotriz/portal-accounts — la agencia crea (o reactiva) la
 * cuenta de portal de un cliente: email + contraseña ligados al Customer
 * canónico. GET lista las cuentas de la empresa.
 */

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const createSchema = z.object({
  customerId: z.string().min(1),
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8).max(200),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { customerId, email, password } = parsed.data;

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { companyId: true },
  });
  if (!customer) throw new AuthzError(404, "Cliente no encontrado");

  await requireWriter(customer.companyId, req);
  await requireModule(customer.companyId, "AUTOMOTRIZ", req);

  const passwordHash = await bcrypt.hash(password, 10);
  const account = await prisma.autoPortalAccount.upsert({
    where: { customerId },
    create: { companyId: customer.companyId, customerId, email, passwordHash },
    update: { email, passwordHash, activo: true },
    select: { id: true, customerId: true, email: true, activo: true, createdAt: true },
  });
  return NextResponse.json(account, { status: 201 });
});

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);
  const accounts = await prisma.autoPortalAccount.findMany({
    where: { companyId },
    select: {
      id: true, email: true, activo: true, lastLoginAt: true, createdAt: true,
      customer: { select: { id: true, razonSocial: true, rfc: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(accounts);
});
