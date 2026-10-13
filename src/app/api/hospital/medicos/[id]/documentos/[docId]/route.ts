/**
 * GET    /api/hospital/medicos/[id]/documentos/[docId]   → el archivo (inline)
 * PATCH  /api/hospital/medicos/[id]/documentos/[docId]   { estado?: VERIFICADO|RECHAZADO|RECIBIDO, numero?, emitidoPor?, vigenciaHasta?, notas? }
 * DELETE /api/hospital/medicos/[id]/documentos/[docId]
 *
 * Verificar deja quién y cuándo; cambiar número o vigencia de un documento
 * verificado lo regresa a RECIBIDO (hay que volver a verificarlo).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, errorZod, fechaSchema } from "@/lib/hospital/http";
import { selectDocumento } from "@/lib/hospital/medico-credencial";


type Ctx = { params: Promise<{ id: string; docId: string }> };

async function documentoDe(ctx: Ctx) {
  const { id, docId } = await ctx.params;
  const doc = await prisma.hospMedicoDocumento.findUnique({ where: { id: docId }, select: { id: true, medicoId: true, companyId: true, tipo: true, estado: true } });
  if (!doc || doc.medicoId !== id) throw new AuthzError(404, "Documento no encontrado");
  return doc;
}

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const doc = await documentoDe(ctx);
  await requireMembership(doc.companyId, undefined, req);
  await requireModule(doc.companyId, "HOSPITAL", req);
  const f = await prisma.hospMedicoDocumento.findUnique({ where: { id: doc.id }, select: { archivo: true, mime: true, nombreArchivo: true } });
  if (!f?.archivo) throw new AuthzError(404, "Este documento no tiene archivo");
  const nombre = (f.nombreArchivo || `${doc.tipo.toLowerCase()}`).replace(/[^\w.-]+/g, "_");
  return new NextResponse(new Uint8Array(f.archivo), {
    headers: { "Content-Type": f.mime ?? "application/octet-stream", "Content-Disposition": `inline; filename="${nombre}"`, "Cache-Control": "private, no-store" },
  });
});

const patchSchema = z.object({
  estado: z.enum(["RECIBIDO", "VERIFICADO", "RECHAZADO"]).optional(),
  numero: z.string().trim().max(60).nullable().optional(),
  emitidoPor: z.string().trim().max(200).nullable().optional(),
  vigenciaHasta: fechaSchema.nullable().optional(),
  notas: z.string().trim().max(1000).nullable().optional(),
});

export const PATCH = withHospital(async (req: Request, ctx: Ctx) => {
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;
  const doc = await documentoDe(ctx);
  const { user } = await requireWriter(doc.companyId, req);
  await requireModule(doc.companyId, "HOSPITAL", req);

  const tocaDatos = d.numero !== undefined || d.vigenciaHasta !== undefined;
  const estado = d.estado ?? (tocaDatos && doc.estado === "VERIFICADO" ? "RECIBIDO" : undefined);
  const actualizado = await prisma.hospMedicoDocumento.update({
    where: { id: doc.id },
    data: {
      ...(d.numero !== undefined ? { numero: d.numero || null } : {}),
      ...(d.emitidoPor !== undefined ? { emitidoPor: d.emitidoPor || null } : {}),
      ...(d.vigenciaHasta !== undefined ? { vigenciaHasta: aFecha(d.vigenciaHasta) } : {}),
      ...(d.notas !== undefined ? { notas: d.notas || null } : {}),
      ...(estado ? { estado } : {}),
      ...(estado === "VERIFICADO" || estado === "RECHAZADO"
        ? { verificadoPorUserId: user.id, verificadoPorNombre: user.name ?? user.email ?? null, verificadoAt: new Date() }
        : estado === "RECIBIDO" ? { verificadoPorUserId: null, verificadoPorNombre: null, verificadoAt: null } : {}),
    },
    select: selectDocumento,
  });
  bitacora(user, req, { companyId: doc.companyId, accion: "hospital.medico.documento.editar", entidad: "HospMedico", entidadId: doc.medicoId, detalle: { tipo: doc.tipo, de: doc.estado, a: actualizado.estado, cambios: Object.keys(d) } });
  return NextResponse.json(actualizado);
});

export const DELETE = withHospital(async (req: Request, ctx: Ctx) => {
  const doc = await documentoDe(ctx);
  const { user } = await requireWriter(doc.companyId, req);
  await requireModule(doc.companyId, "HOSPITAL", req);
  await prisma.hospMedicoDocumento.delete({ where: { id: doc.id } });
  bitacora(user, req, { companyId: doc.companyId, accion: "hospital.medico.documento.borrar", entidad: "HospMedico", entidadId: doc.medicoId, detalle: { tipo: doc.tipo, estado: doc.estado } });
  return NextResponse.json({ ok: true });
});
