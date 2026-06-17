/**
 * GET  /api/construccion/solicitudes-compra/[id]/cotizaciones
 * POST /api/construccion/solicitudes-compra/[id]/cotizaciones
 *
 * Each requisición collects 1..N quotes (one per vendor). POST creates
 * a cotización with its line items priced — the body mirrors the
 * "Copia de REQUISICION DE MATERIAL N 10" Excel: vendor name + a row
 * per requested partida with a precio unitario.
 *
 * Total is computed server-side from the lines.
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

const lineSchema = z.object({
  solicitudPartidaId: z.string().min(1),
  precioUnitario: z.number().nonnegative(),
  tiempoEntrega: z.string().max(80).nullable().optional(),
  notas: z.string().max(200).nullable().optional(),
});

const createSchema = z.object({
  supplierId: z.string().min(1).nullable().optional(),
  supplierNombre: z.string().min(1).max(120),
  tieneCredito: z.boolean().optional(),
  fechaCotizacion: z.string().optional(),
  vigenciaHasta: z.string().nullable().optional(),
  moneda: z.string().max(3).optional(),
  notas: z.string().max(500).nullable().optional(),
  archivoUrl: z.string().max(1000).nullable().optional(),
  archivoData: z.string().nullable().optional(),
  archivoMime: z.string().max(80).nullable().optional(),
  archivoName: z.string().max(200).nullable().optional(),
  lineas: z.array(lineSchema).min(1),
});

const round2 = (n: number) => Math.round(n * 100) / 100;

async function loadSolicitud(id: string, req: Request, write: boolean) {
  const sol = await prisma.solicitudCompra.findUnique({
    where: { id },
    select: { id: true, companyId: true, partidas: { select: { id: true, cantidad: true } } },
  });
  if (!sol) throw new AuthzError(404, "Solicitud no encontrada");
  if (write) await requireWriter(sol.companyId, req);
  else await requireMembership(sol.companyId, undefined, req);
  await requireModule(sol.companyId, "CONSTRUCCION");
  return sol;
}

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    await loadSolicitud(id, req, false);
    const cots = await prisma.solicitudCompraCotizacion.findMany({
      where: { solicitudId: id },
      include: {
        supplier: { select: { id: true, razonSocial: true, rfc: true } },
        partidas: {
          select: {
            id: true,
            solicitudPartidaId: true,
            precioUnitario: true,
            importe: true,
            tiempoEntrega: true,
            notas: true,
          },
        },
      },
      orderBy: { fechaCotizacion: "desc" },
    });
    return NextResponse.json(cots);
  }
);

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const sol = await loadSolicitud(id, req, true);
    const body = await req.json().catch(() => ({}));
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const data = parsed.data;

    // Validate every line points at a real partida of this solicitud
    const validIds = new Set(sol.partidas.map((p) => p.id));
    for (const l of data.lineas) {
      if (!validIds.has(l.solicitudPartidaId)) {
        return NextResponse.json(
          { error: `solicitudPartidaId ${l.solicitudPartidaId} no pertenece a esta solicitud` },
          { status: 400 }
        );
      }
    }

    // Compute importe per line + total cotización
    const cantById = new Map(sol.partidas.map((p) => [p.id, p.cantidad]));
    const linesWithImporte = data.lineas.map((l) => {
      const qty = cantById.get(l.solicitudPartidaId) ?? 0;
      const importe = round2(qty * l.precioUnitario);
      return { ...l, importe };
    });
    const total = round2(linesWithImporte.reduce((a, l) => a + l.importe, 0));

    const created = await prisma.solicitudCompraCotizacion.create({
      data: {
        solicitudId: id,
        supplierId: data.supplierId ?? null,
        supplierNombre: data.supplierNombre,
        tieneCredito: data.tieneCredito ?? false,
        fechaCotizacion: data.fechaCotizacion ? new Date(data.fechaCotizacion) : new Date(),
        vigenciaHasta: data.vigenciaHasta ? new Date(data.vigenciaHasta) : null,
        total,
        moneda: data.moneda ?? "MXN",
        notas: data.notas ?? null,
        archivoUrl: data.archivoUrl ?? null,
        archivoData: data.archivoData ?? null,
        archivoMime: data.archivoMime ?? null,
        archivoName: data.archivoName ?? null,
        partidas: {
          create: linesWithImporte.map((l) => ({
            solicitudPartidaId: l.solicitudPartidaId,
            precioUnitario: l.precioUnitario,
            importe: l.importe,
            tiempoEntrega: l.tiempoEntrega ?? null,
            notas: l.notas ?? null,
          })),
        },
      },
      include: { partidas: true },
    });
    return NextResponse.json(created, { status: 201 });
  }
);
