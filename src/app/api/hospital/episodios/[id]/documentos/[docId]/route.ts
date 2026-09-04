/**
 * PATCH /api/hospital/episodios/[id]/documentos/[docId] — { estado, firmadoAt? }
 * FIRMADO fija `firmadoAt` (ahora, si no viene). Volver a PENDIENTE lo borra.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, errorZod, fechaSchema } from "@/lib/hospital/http";

const schema = z.object({
  estado: z.enum(["PENDIENTE", "RECIBIDO", "FIRMADO"]),
  firmadoAt: fechaSchema.nullable().optional(),
  nombre: z.string().min(1).max(200).optional(),
  requerido: z.boolean().optional(),
});

export const PATCH = withHospital(async (req: Request, ctx: { params: Promise<{ id: string; docId: string }> }) => {
  const { id, docId } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const doc = await prisma.hospDocumento.findUnique({
    where: { id: docId },
    include: { episodio: { select: { id: true, companyId: true, folio: true } } },
  });
  if (!doc || doc.episodioId !== id) throw new AuthzError(404, "Documento no encontrado");

  const { user } = await requireWriter(doc.episodio.companyId, req);
  await requireModule(doc.episodio.companyId, "HOSPITAL", req);

  const firmadoAt =
    d.estado === "FIRMADO" ? (aFecha(d.firmadoAt) ?? doc.firmadoAt ?? new Date()) : d.estado === "PENDIENTE" ? null : (aFecha(d.firmadoAt) ?? doc.firmadoAt);

  const actualizado = await prisma.hospDocumento.update({
    where: { id: docId },
    data: { estado: d.estado, firmadoAt, ...(d.nombre ? { nombre: d.nombre.trim() } : {}), ...(d.requerido !== undefined ? { requerido: d.requerido } : {}) },
  });

  if (doc.estado !== d.estado) {
    bitacora(user, req, {
      companyId: doc.episodio.companyId,
      accion: "hospital.documento.estado",
      entidad: "HospDocumento",
      entidadId: docId,
      detalle: { folio: doc.episodio.folio, tipo: doc.tipo, de: doc.estado, a: d.estado },
    });
  }

  return NextResponse.json(actualizado);
});
