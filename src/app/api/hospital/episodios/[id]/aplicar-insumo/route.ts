/**
 * POST /api/hospital/episodios/[id]/aplicar-insumo
 *   { insumoId, loteId?, cantidad, nota?, fecha?, medicoId?,
 *     recetaRef?, prescriptorNombre?, prescriptorCedula?, contexto?: SUMINISTRO_HOSPITALARIO|VENTA_DIRECTA }
 *
 * Kardex + cargo + nota en una transacción (ver lib/hospital/aplicar-insumo).
 * Controlados I-III: `recetaRef` obligatoria y prescriptor con cédula (del
 * médico o explícito) — 400/409 con el motivo. El cargo nace con su
 * `ivaContexto` (criterio 9/IVA/N): suministro salvo en CONSULTA o cuando se
 * pide VENTA_DIRECTA.
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
  recetaRef: z.string().trim().max(60).nullable().optional(),
  prescriptorNombre: z.string().trim().max(160).nullable().optional(),
  prescriptorCedula: z.string().trim().max(20).nullable().optional(),
  contexto: z.enum(["SUMINISTRO_HOSPITALARIO", "VENTA_DIRECTA"]).nullable().optional(),
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
    recetaRef: d.recetaRef ?? null,
    prescriptorNombre: d.prescriptorNombre ?? null,
    prescriptorCedula: d.prescriptorCedula ?? null,
    contexto: d.contexto ?? null,
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
      ivaTasa: resultado.cargo.ivaTasa == null ? null : Number(resultado.cargo.ivaTasa),
      ivaContexto: resultado.cargo.ivaContexto,
      recetaRef: resultado.movimiento.recetaRef,
      prescriptorCedula: resultado.movimiento.prescriptorCedula,
      existenciaLote: Number(resultado.lote.existencia),
    },
  });

  return NextResponse.json(resultado, { status: 201 });
});
