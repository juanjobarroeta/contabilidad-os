/**
 * POST /api/hospital/documentos/[docId]/firmas
 *      { rol, nombre, identificacion?, parentesco?, imagen (data URL PNG ≤ 300 KB), geolocalizacion? }
 *
 * Firma electrónica simple sobre un documento con texto legal: guarda el
 * trazo, hashDocumento = documento.hashContenido, hashFirma = sha256(imagen |
 * hashDocumento | rol | nombre | at), IP y user agent del request y el usuario
 * que capturó. Cada rol (o su alternativa PACIENTE|REPRESENTANTE) firma una
 * vez (409 si repite); con todas las requeridas el documento pasa a FIRMADO y,
 * si es el aviso de privacidad, la ficha registra la aceptación. Nada se edita
 * ni se borra.
 *   400 imagen/rol/nombre inválidos o rol no requerido · 409 ya firmado / sin texto firmable
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { ipDeRequest } from "@/lib/audit";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, errorZod } from "@/lib/hospital/http";
import { firmarDocumento } from "@/lib/hospital/firmas";
import { ROLES_FIRMANTE } from "@/lib/hospital/plantillas-legales";

const schema = z.object({
  rol: z.enum(ROLES_FIRMANTE as unknown as [string, ...string[]]),
  nombre: z.string().trim().min(2).max(160),
  identificacion: z.string().trim().max(40).nullable().optional(),
  parentesco: z.string().trim().max(60).nullable().optional(),
  imagen: z.string().min(1).max(450_000),
  geolocalizacion: z.string().trim().max(120).nullable().optional(),
});

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ docId: string }> }) => {
  const { docId } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const doc = await prisma.hospDocumento.findUnique({ where: { id: docId }, select: { id: true, companyId: true, tipo: true, nombre: true, episodio: { select: { folio: true } } } });
  if (!doc) throw new AuthzError(404, "Documento no encontrado");

  const { user } = await requireWriter(doc.companyId, req);
  await requireModule(doc.companyId, "HOSPITAL", req);

  const r = await firmarDocumento(prisma, {
    documentoId: doc.id,
    rol: d.rol as (typeof ROLES_FIRMANTE)[number],
    nombre: d.nombre,
    identificacion: d.identificacion,
    parentesco: d.parentesco,
    imagen: d.imagen,
    geolocalizacion: d.geolocalizacion,
    ip: ipDeRequest(req),
    userAgent: req.headers.get("user-agent"),
    user,
  });

  bitacora(user, req, {
    companyId: doc.companyId,
    accion: "hospital.documento.firmar",
    entidad: "HospDocumento",
    entidadId: doc.id,
    detalle: { folio: doc.episodio?.folio ?? null, tipo: doc.tipo, nombre: doc.nombre, rol: d.rol, firmante: d.nombre, hashFirma: r.firma.hashFirma, estado: r.documento.estado, faltan: r.faltan },
  });

  return NextResponse.json({ firma: r.firma, documento: r.documento, faltan: r.faltan, estado: r.documento.estado }, { status: 201 });
});
