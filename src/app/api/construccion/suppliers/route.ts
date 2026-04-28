/**
 * GET  /api/construccion/suppliers?companyId=... [&q=...]
 * POST /api/construccion/suppliers
 *
 * Bearer-aware suppliers (proveedores) endpoint for bartiz. The same
 * Supplier rows show up in contabilidad-os bancos for SPEI matching
 * and in cotizaciones for vendor selection — one source of truth.
 *
 * GET supports an optional `q` substring filter (matches razónSocial
 * + RFC, case-insensitive) for typeahead in the cotización picker.
 *
 * POST body:
 *   { companyId, rfc, razonSocial, regimenFiscal?, email? }
 * Unique on (companyId, rfc) so re-creating with the same RFC is
 * a 409 — caller should fetch the existing row instead.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  requireMembership,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

const createSchema = z.object({
  companyId: z.string().min(1),
  rfc: z.string().min(1).max(13).transform((v) => v.toUpperCase().trim()),
  razonSocial: z.string().min(1).max(200),
  regimenFiscal: z.string().max(10).nullable().optional(),
  email: z.string().email().max(200).nullable().optional(),
});

export const GET = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  const where: Record<string, unknown> = { companyId };
  if (q) {
    where.OR = [
      { razonSocial: { contains: q, mode: "insensitive" } },
      { rfc: { contains: q.toUpperCase() } },
    ];
  }

  const suppliers = await prisma.supplier.findMany({
    where,
    include: {
      _count: {
        select: { cotizaciones: true, solicitudesCompra: true, bankTransactions: true },
      },
    },
    orderBy: { razonSocial: "asc" },
    take: 200,
  });

  return NextResponse.json(suppliers);
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;
  await requireWriter(data.companyId, req);
  await requireModule(data.companyId, "CONSTRUCCION");

  try {
    const created = await prisma.supplier.create({
      data: {
        companyId: data.companyId,
        rfc: data.rfc,
        razonSocial: data.razonSocial.trim(),
        regimenFiscal: data.regimenFiscal ?? null,
        email: data.email ?? null,
      },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "P2002") {
      // Duplicate RFC — return the existing row so the client can use it
      const existing = await prisma.supplier.findFirst({
        where: { companyId: data.companyId, rfc: data.rfc },
      });
      return NextResponse.json(
        { error: `Ya existe un proveedor con RFC ${data.rfc}`, existing },
        { status: 409 }
      );
    }
    throw e;
  }
});
