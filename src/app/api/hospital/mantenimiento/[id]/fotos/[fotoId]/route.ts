/**
 * GET    /api/hospital/mantenimiento/[id]/fotos/[fotoId] → la imagen
 * DELETE /api/hospital/mantenimiento/[id]/fotos/[fotoId] → { ok }
 *
 * Los bytes se sirven aquí y sólo aquí, con su content-type. `private` en el
 * Cache-Control porque una foto de un reporte puede tener a alguien dentro:
 * no debe quedarse en una caché compartida.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora } from "@/lib/hospital/http";

type Ctx = { params: Promise<{ id: string; fotoId: string }> };

async function fotoDe(id: string, fotoId: string) {
  const f = await prisma.hospTicketFoto.findUnique({
    where: { id: fotoId },
    select: { id: true, companyId: true, ticketId: true, mime: true, archivo: true, bytes: true, ticket: { select: { folio: true } } },
  });
  if (!f || f.ticketId !== id) throw new AuthzError(404, "Foto no encontrada");
  return f;
}

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id, fotoId } = await ctx.params;
  const f = await fotoDe(id, fotoId);
  await requireMembership(f.companyId, undefined, req);
  await requireModule(f.companyId, "HOSPITAL", req);

  return new NextResponse(Buffer.from(f.archivo), {
    headers: {
      "Content-Type": f.mime,
      "Content-Length": String(f.bytes),
      "Cache-Control": "private, max-age=3600",
    },
  });
});

export const DELETE = withHospital(async (req: Request, ctx: Ctx) => {
  const { id, fotoId } = await ctx.params;
  const f = await fotoDe(id, fotoId);
  const { user } = await requireWriter(f.companyId, req);
  await requireModule(f.companyId, "HOSPITAL", req);

  await prisma.hospTicketFoto.delete({ where: { id: f.id } });
  bitacora(user, req, {
    companyId: f.companyId,
    accion: "hospital.mantenimiento.foto.borrar",
    entidad: "HospTicketFoto",
    entidadId: f.id,
    detalle: { folio: f.ticket.folio },
  });
  return NextResponse.json({ ok: true });
});
