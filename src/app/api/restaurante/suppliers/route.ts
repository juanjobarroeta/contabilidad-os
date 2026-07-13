/**
 * GET  /api/restaurante/suppliers?companyId=... [&q=...]
 * POST /api/restaurante/suppliers
 *
 * Bearer-aware proveedores endpoint for restauranteos, gated by the
 * RESTAURANTE module. Same canonical Supplier rows the rest of the hub uses
 * (bancos SPEI matching, construcción cotizaciones) — one source of truth.
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
  const suppliers = await prisma.supplier.findMany({
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
    select: { id: true, rfc: true, razonSocial: true, email: true },
    orderBy: { razonSocial: "asc" },
  });
  return NextResponse.json(suppliers);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  rfc: z.string().min(1).max(13).transform((v) => v.toUpperCase().trim()),
  razonSocial: z.string().min(1).max(200),
  regimenFiscal: z.string().max(10).nullable().optional(),
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

  const existing = await prisma.supplier.findUnique({
    where: { companyId_rfc: { companyId, rfc: data.rfc } },
    select: { id: true, razonSocial: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: `Ya existe un proveedor con RFC ${data.rfc} (${existing.razonSocial})` },
      { status: 409 }
    );
  }

  const supplier = await prisma.supplier.create({ data: { companyId, ...data } });
  return NextResponse.json(supplier, { status: 201 });
});
