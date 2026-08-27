/**
 * GET    /api/construccion/suppliers/[id]
 * PUT    /api/construccion/suppliers/[id]
 * DELETE /api/construccion/suppliers/[id]
 *
 * Detail returns the supplier + cotización history (with the parent
 * solicitud + ganador flag), recent SolicitudCompra OCs, and recent
 * outgoing BankTransactions. Drives the Proveedores detail page.
 *
 * DELETE is hard if no FK rows reference it; otherwise rejects with
 * 409 + a count so the user can decide.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireMembership,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

const putSchema = z.object({
  rfc: z.string().min(1).max(13).transform((v) => v.toUpperCase().trim()).optional(),
  razonSocial: z.string().min(1).max(200).optional(),
  regimenFiscal: z.string().max(10).nullable().optional(),
  email: z.string().email().max(200).nullable().optional(),
  clabe: z
    .string()
    .trim()
    .regex(/^\d{18}$/, "CLABE debe tener 18 dígitos")
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  banco: z.string().max(60).nullable().optional(),
  cuentaBancaria: z.string().max(30).nullable().optional(),
  titularCuenta: z.string().max(200).nullable().optional(),
});

async function loadSupplier(id: string, req: Request, write = false) {
  const s = await prisma.supplier.findUnique({
    where: { id },
    select: { id: true, companyId: true },
  });
  if (!s) throw new AuthzError(404, "Proveedor no encontrado");
  if (write) await requireWriter(s.companyId, req);
  else await requireMembership(s.companyId, undefined, req);
  await requireModule(s.companyId, "CONSTRUCCION");
  return s;
}

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    await loadSupplier(id, req, false);

    const supplier = await prisma.supplier.findUnique({
      where: { id },
      include: {
        terms: true,
        cotizaciones: {
          include: {
            solicitud: {
              select: {
                id: true,
                folio: true,
                estado: true,
                proyecto: { select: { codigo: true, nombre: true } },
                supplierId: true,
              },
            },
            partidas: { select: { id: true, importe: true } },
          },
          orderBy: { fechaCotizacion: "desc" },
          take: 100,
        },
        solicitudesCompra: {
          select: {
            id: true,
            folio: true,
            estado: true,
            total: true,
            createdAt: true,
            proyecto: { select: { codigo: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        },
        bankTransactions: {
          select: {
            id: true,
            fecha: true,
            descripcion: true,
            monto: true,
            referencia: true,
            status: true,
            bankAccount: { select: { banco: true, nombre: true } },
            solicitudCompraPagada: {
              select: { id: true, folio: true, proyecto: { select: { codigo: true } } },
            },
          },
          orderBy: { fecha: "desc" },
          take: 50,
        },
      },
    });

    if (!supplier) throw new AuthzError(404, "Proveedor no encontrado");

    // Add a "wonCotizaciones" count and totalSpent across cotizaciones
    const wonCount = supplier.cotizaciones.filter((c) => c.isSelected).length;
    const totalQuoted = supplier.cotizaciones.reduce((a, c) => a + Number(c.total), 0);
    const totalSpent = supplier.solicitudesCompra
      .filter((s) => s.estado === "PAGADA")
      .reduce((a, s) => a + Number(s.total), 0);

    return NextResponse.json({
      ...supplier,
      stats: { wonCount, totalQuoted, totalSpent },
    });
  }
);

export const PUT = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    await loadSupplier(id, req, true);
    const body = await req.json().catch(() => ({}));
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const updated = await prisma.supplier.update({
      where: { id },
      data: {
        ...(parsed.data.rfc && { rfc: parsed.data.rfc }),
        ...(parsed.data.razonSocial && { razonSocial: parsed.data.razonSocial.trim() }),
        ...(parsed.data.regimenFiscal !== undefined && { regimenFiscal: parsed.data.regimenFiscal }),
        ...(parsed.data.email !== undefined && { email: parsed.data.email }),
        ...(parsed.data.clabe !== undefined && { clabe: parsed.data.clabe }),
        ...(parsed.data.banco !== undefined && { banco: parsed.data.banco?.trim() || null }),
        ...(parsed.data.cuentaBancaria !== undefined && { cuentaBancaria: parsed.data.cuentaBancaria?.trim() || null }),
        ...(parsed.data.titularCuenta !== undefined && { titularCuenta: parsed.data.titularCuenta?.trim() || null }),
      },
    });
    return NextResponse.json(updated);
  }
);

export const DELETE = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    await loadSupplier(id, req, true);

    const counts = await prisma.supplier.findUnique({
      where: { id },
      select: {
        _count: {
          select: {
            cotizaciones: true,
            solicitudesCompra: true,
            bankTransactions: true,
          },
        },
      },
    });
    const totalRefs =
      (counts?._count.cotizaciones ?? 0) +
      (counts?._count.solicitudesCompra ?? 0) +
      (counts?._count.bankTransactions ?? 0);
    if (totalRefs > 0) {
      return NextResponse.json(
        {
          error: `No se puede eliminar: hay ${totalRefs} referencia(s) (cotizaciones / OCs / movimientos bancarios) apuntando a este proveedor.`,
          refs: counts?._count,
        },
        { status: 409 }
      );
    }

    await prisma.supplier.delete({ where: { id } });
    return NextResponse.json({ deleted: id });
  }
);
