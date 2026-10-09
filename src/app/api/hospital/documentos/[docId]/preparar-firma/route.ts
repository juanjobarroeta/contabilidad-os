/**
 * POST /api/hospital/documentos/[docId]/preparar-firma
 *      → congela el texto legal de un consentimiento clínico o del
 *        cuestionario de imagen con su contenido actual (textoFirmado +
 *        hashContenido) y fija los firmantes, listo para
 *        POST /documentos/[docId]/firmas. Exige el contenido mínimo.
 *   400 tipo sin firma en pantalla o contenido incompleto · 409 ya firmado o con firmas
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora } from "@/lib/hospital/http";
import { prepararFirmaDocumento } from "@/lib/hospital/admision";

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ docId: string }> }) => {
  const { docId } = await ctx.params;
  const doc = await prisma.hospDocumento.findUnique({ where: { id: docId }, select: { id: true, companyId: true, tipo: true, nombre: true, episodio: { select: { folio: true } } } });
  if (!doc) throw new AuthzError(404, "Documento no encontrado");

  const { user } = await requireWriter(doc.companyId, req);
  await requireModule(doc.companyId, "HOSPITAL", req);

  const { documento, advertencias } = await prepararFirmaDocumento(prisma, { documentoId: doc.id });

  bitacora(user, req, {
    companyId: doc.companyId,
    accion: "hospital.documento.preparar_firma",
    entidad: "HospDocumento",
    entidadId: doc.id,
    detalle: { folio: doc.episodio?.folio ?? null, tipo: doc.tipo, nombre: doc.nombre, plantillaVersion: documento.plantillaVersion, hashContenido: documento.hashContenido },
  });

  return NextResponse.json({ ...documento, advertencias });
});
