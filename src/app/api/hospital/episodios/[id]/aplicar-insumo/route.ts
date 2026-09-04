/**
 * POST /api/hospital/episodios/[id]/aplicar-insumo
 *   { insumoId, loteId?, cantidad, nota?, fecha?, medicoId? }
 *
 * Kardex + cargo + nota en una transacción (ver lib/hospital/aplicar-insumo).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, errorZod, fechaSchema, usuarioDe } from "@/lib/hospital/http";
import { aplicarInsumo } from "@/lib/hospital/aplicar-insumo";

const schema = z.object({
  insumoId: z.string().min(1),
  loteId: z.string().nullable().optional(),
  cantidad: z.number().positive().max(100000),
  nota: z.string().max(2000).nullable().optional(),
  fecha: fechaSchema.nullable().optional(),
  medicoId: z.string().nullable().optional(),
});

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const ep = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true, folio: true } });
  if (!ep) throw new AuthzError(404, "Episodio no encontrado");

  const { user } = await requireWriter(ep.companyId, req);
  await requireModule(ep.companyId, "HOSPITAL", req);
  const usuario = usuarioDe(user);

  const resultado = await aplicarInsumo(prisma, {
    companyId: ep.companyId,
    episodioId: ep.id,
    insumoId: d.insumoId,
    loteId: d.loteId ?? null,
    cantidad: d.cantidad,
    usuarioId: usuario.id,
    usuarioNombre: usuario.nombre,
    nota: d.nota ?? null,
    fecha: aFecha(d.fecha) ?? undefined,
    medicoId: d.medicoId ?? null,
  });

  bitacora(user, req, {
    companyId: ep.companyId,
    accion: "hospital.insumo.aplicar",
    entidad: "HospCargo",
    entidadId: resultado.cargo.id,
    detalle: {
      folio: ep.folio,
      insumoId: d.insumoId,
      lote: resultado.lote.lote,
      cantidad: d.cantidad,
      importe: Number(resultado.cargo.importe),
      existenciaLote: Number(resultado.lote.existencia),
    },
  });

  return NextResponse.json(resultado, { status: 201 });
});
