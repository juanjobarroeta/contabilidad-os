/**
 * Cuenta corriente del proveedor — pagos (abonos).
 *
 * POST /api/construccion/pagos-proveedor
 *   Registra un pago al proveedor y opcionalmente lo aplica a adjudicaciones
 *   (parciales permitidas). Lo no aplicado queda como anticipo/saldo a favor.
 *   NO crea movimiento bancario ni asiento: el banco es del CSV importado y
 *   la conciliación (CFDI ↔ movimiento) vive aparte.
 *   Body: { companyId, supplierId?, supplierNombre, fecha?, monto, referencia?,
 *           notas?, comprobante?: { data, mime, name },
 *           aplicaciones?: [{ adjudicacionId, monto }] }
 *
 * GET /api/construccion/pagos-proveedor?companyId=…[&supplierId=…][&supplierNombre=…]
 *   Lista pagos con sus aplicaciones y el disponible (anticipo) de cada uno.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { aplicarPago } from "@/lib/construccion/pagos-proveedor";

const createSchema = z.object({
  companyId: z.string().min(1),
  supplierId: z.string().min(1).nullable().optional(),
  supplierNombre: z.string().min(1).max(200),
  fecha: z.string().datetime().optional(),
  monto: z.number().positive(),
  referencia: z.string().max(120).nullable().optional(),
  notas: z.string().max(500).nullable().optional(),
  comprobante: z
    .object({
      data: z.string().min(1),
      mime: z.string().max(120).optional(),
      name: z.string().max(200).optional(),
    })
    .nullable()
    .optional(),
  aplicaciones: z
    .array(z.object({ adjudicacionId: z.string().min(1), monto: z.number().positive() }))
    .default([]),
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

  if (data.supplierId) {
    const s = await prisma.supplier.findUnique({
      where: { id: data.supplierId },
      select: { companyId: true },
    });
    if (!s || s.companyId !== data.companyId) {
      return NextResponse.json({ error: "Proveedor inválido" }, { status: 400 });
    }
  }
  const sumAplicaciones = data.aplicaciones.reduce((s, a) => s + a.monto, 0);
  if (sumAplicaciones > data.monto + 0.01) {
    return NextResponse.json(
      { error: "Las aplicaciones exceden el monto del pago" },
      { status: 422 }
    );
  }

  const fecha = data.fecha ? new Date(data.fecha) : new Date();

  try {
    const result = await prisma.$transaction(async (tx) => {
      const pago = await tx.pagoProveedor.create({
        data: {
          companyId: data.companyId,
          supplierId: data.supplierId ?? null,
          supplierNombre: data.supplierNombre,
          fecha,
          monto: data.monto,
          referencia: data.referencia ?? null,
          notas: data.notas ?? null,
          comprobanteData: data.comprobante?.data ?? null,
          comprobanteMime: data.comprobante?.mime ?? null,
          comprobanteName: data.comprobante?.name ?? null,
        },
      });
      const aplicado = await aplicarPago(tx, pago, data.aplicaciones, fecha);
      return { pago, aplicado, anticipo: Math.max(0, data.monto - aplicado) };
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error al registrar el pago";
    return NextResponse.json({ error: msg }, { status: 422 });
  }
});

export const GET = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  const supplierId = url.searchParams.get("supplierId");
  const supplierNombre = url.searchParams.get("supplierNombre");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  const pagos = await prisma.pagoProveedor.findMany({
    where: {
      companyId,
      ...(supplierId ? { supplierId } : {}),
      ...(supplierNombre
        ? { supplierNombre: { equals: supplierNombre, mode: "insensitive" } }
        : {}),
    },
    include: {
      supplier: { select: { id: true, razonSocial: true, rfc: true } },
      aplicaciones: {
        select: {
          id: true,
          monto: true,
          adjudicacion: {
            select: {
              id: true,
              supplierNombre: true,
              total: true,
              estado: true,
              solicitud: { select: { id: true, folio: true } },
            },
          },
        },
      },
    },
    orderBy: { fecha: "desc" },
    take: 200,
  });

  const out = pagos.map((p) => {
    const aplicado = p.aplicaciones.reduce((s, a) => s + a.monto, 0);
    return {
      id: p.id,
      supplierId: p.supplierId,
      supplierNombre: p.supplierNombre,
      supplier: p.supplier,
      fecha: p.fecha,
      monto: p.monto,
      referencia: p.referencia,
      notas: p.notas,
      comprobanteName: p.comprobanteName,
      aplicado,
      disponible: Math.max(0, p.monto - aplicado),
      aplicaciones: p.aplicaciones,
      createdAt: p.createdAt,
    };
  });

  return NextResponse.json(out);
});
