/**
 * POST /api/hospital/episodios/[id]/documentos — registra un documento del
 * expediente (nace PENDIENTE; el archivo es opcional en v1).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";

const schema = z.object({
  tipo: z.enum(["CONSENTIMIENTO_CIRUGIA", "CONSENTIMIENTO_ANESTESIA", "IDENTIFICACION", "POLIZA", "CARTA_AUTORIZACION", "ESTUDIO", "RESULTADO", "RECETA", "NOTA_EGRESO", "OTRO"]),
  nombre: z.string().min(1).max(200),
  requerido: z.boolean().optional(),
  estado: z.enum(["PENDIENTE", "RECIBIDO", "FIRMADO"]).optional(),
});

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const ep = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true, estado: true, folio: true } });
  if (!ep) throw new AuthzError(404, "Episodio no encontrado");

  const { user } = await requireWriter(ep.companyId, req);
  await requireModule(ep.companyId, "HOSPITAL", req);
  if (ep.estado === "CANCELADO") return error(`El episodio ${ep.folio} está cancelado`, 409);

  const doc = await prisma.hospDocumento.create({
    data: {
      companyId: ep.companyId,
      episodioId: ep.id,
      tipo: d.tipo,
      nombre: d.nombre.trim(),
      requerido: d.requerido ?? true,
      estado: d.estado ?? "PENDIENTE",
      firmadoAt: d.estado === "FIRMADO" ? new Date() : null,
      subidoPorUserId: user.id,
    },
  });

  bitacora(user, req, {
    companyId: ep.companyId,
    accion: "hospital.documento.crear",
    entidad: "HospDocumento",
    entidadId: doc.id,
    detalle: { folio: ep.folio, tipo: d.tipo, nombre: doc.nombre, estado: doc.estado },
  });

  return NextResponse.json(doc, { status: 201 });
});
