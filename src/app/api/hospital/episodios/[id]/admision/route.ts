/**
 * POST /api/hospital/episodios/[id]/admision
 *
 * Crea lo que falte del paquete estándar de admisión según el tipo de
 * episodio y su pagador —aviso de privacidad (si no está firmado en la
 * versión vigente), consentimiento de datos sensibles (pagador ≠ particular),
 * contrato de servicios, compromiso de pago, cesión de derechos (aseguradora),
 * consentimiento de ingreso (hospitalización / ambulatorio) e identificación
 * (pendiente de archivo)— con su texto legal resuelto y su hash, y devuelve
 * todos los documentos del paciente y del episodio con sus firmas.
 * Idempotente: lo ya registrado se omite (`omitidos` dice por qué).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora } from "@/lib/hospital/http";
import { paqueteAdmision } from "@/lib/hospital/admision";

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const ep = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true, folio: true } });
  if (!ep) throw new AuthzError(404, "Episodio no encontrado");

  const { user } = await requireWriter(ep.companyId, req);
  await requireModule(ep.companyId, "HOSPITAL", req);

  const paquete = await paqueteAdmision(prisma, { episodioId: ep.id, user });

  if (paquete.creados.length || paquete.completados.length) {
    bitacora(user, req, {
      companyId: ep.companyId,
      accion: "hospital.admision.paquete",
      entidad: "HospEpisodio",
      entidadId: ep.id,
      detalle: { folio: ep.folio, requeridos: paquete.requeridos, creados: paquete.creados.length, completados: paquete.completados.length, omitidos: paquete.omitidos.map((o) => o.tipo) },
    });
  }

  return NextResponse.json(paquete, { status: paquete.creados.length ? 201 : 200 });
});
