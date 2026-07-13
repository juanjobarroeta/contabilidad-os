/**
 * GET  /api/restaurante/customers?companyId=... [&q=...]
 * POST /api/restaurante/customers
 *
 * Bearer-aware clientes fiscales endpoint for restauranteos, gated by the
 * RESTAURANTE module. Canonical Customer rows — the same ones the hub's
 * facturación uses, so an order invoiced from the POS lands on the right
 * fiscal customer. Facturapi provisioning of the customer happens inside
 * POST /api/facturas when stamping.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "RESTAURANTE", req);

  const q = searchParams.get("q");
  const customers = await prisma.customer.findMany({
    where: {
      companyId,
      ...(q
        ? {
            OR: [
              { razonSocial: { contains: q, mode: "insensitive" } },
              { rfc: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      rfc: true,
      razonSocial: true,
      regimenFiscal: true,
      email: true,
      codigoPostal: true,
    },
    orderBy: { razonSocial: "asc" },
  });
  return NextResponse.json(customers);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  rfc: z.string().min(12).max(13).transform((v) => v.toUpperCase().trim()),
  razonSocial: z.string().min(1).max(200),
  regimenFiscal: z.string().min(1).max(10),
  codigoPostal: z.string().min(5).max(5),
  email: z.string().email().max(200).nullable().optional(),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, ...data } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "RESTAURANTE", req);

  const existing = await prisma.customer.findUnique({
    where: { companyId_rfc: { companyId, rfc: data.rfc } },
    select: { id: true, razonSocial: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: `Ya existe un cliente con RFC ${data.rfc} (${existing.razonSocial})` },
      { status: 409 }
    );
  }

  const customer = await prisma.customer.create({ data: { companyId, ...data } });
  return NextResponse.json(customer, { status: 201 });
});
