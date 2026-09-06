/**
 * GET /api/hospital/documentos/[docId][?firmas=1]
 *
 * El documento (sin bytes) con su texto firmado, sus firmas y la evidencia
 * { hashContenido, plantillaVersion, completo, firmas: [{ rol, nombre, at, ip,
 * hashFirma }] }. Con `firmas=1` las firmas traen el trazo (imagen PNG) y
 * `hashVerificado` recalculado; esa lectura queda en HospAcceso (LECTURA_FICHA)
 * porque expone datos personales del firmante.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { registrarAcceso } from "@/lib/hospital/accesos";
import { cargarDocumento, documentoConFirmas } from "@/lib/hospital/firmas";
import { nombreCompleto } from "@/lib/hospital/util";

export const GET = withHospital(async (req: Request, ctx: { params: Promise<{ docId: string }> }) => {
  const { docId } = await ctx.params;
  const doc = await cargarDocumento(prisma, docId);

  const { user } = await requireMembership(doc.companyId, undefined, req);
  await requireModule(doc.companyId, "HOSPITAL", req);

  const conImagen = new URL(req.url).searchParams.get("firmas") === "1";
  if (conImagen && doc.firmas.length) {
    registrarAcceso({
      companyId: doc.companyId,
      accion: "LECTURA_FICHA",
      pacienteId: doc.pacienteId,
      episodioId: doc.episodioId,
      detalle: `Documento «${doc.nombre}» con ${doc.firmas.length} firma(s)`,
      user,
      req,
    });
  }

  const { episodio, paciente, ...fila } = doc;
  return NextResponse.json({
    ...documentoConFirmas(fila, { conImagen }),
    episodio,
    paciente: paciente ? { id: paciente.id, nombreCompleto: nombreCompleto(paciente), expedienteNumero: paciente.expedienteNumero } : null,
  });
});
