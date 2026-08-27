import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// GET/DELETE /api/automotriz/ordenes/[id]/documentos/[docId] — descarga y
// baja de un documento del expediente. El CONTRATO_FIRMADO no se borra jamás
// (es el artefacto legal); una foto mal tomada sí (para re-tomarla).
// ─────────────────────────────────────────────────────────────────────────────

type Params = { params: Promise<{ id: string; docId: string }> };

export const GET = withAuthz(async (req: Request, ctx: Params) => {
  const { id, docId } = await ctx.params;
  const doc = await prisma.ordenDocumento.findFirst({ where: { id: docId, ordenId: id } });
  if (!doc) throw new AuthzError(404, "Documento no encontrado");
  await requireMembership(doc.companyId, undefined, req);
  await requireModule(doc.companyId, "AUTOMOTRIZ", req);

  const nombre = doc.nombre.replace(/[^\w.\- ()]/g, "_");
  return new NextResponse(new Uint8Array(doc.datos), {
    headers: {
      "Content-Type": doc.mime,
      "Content-Length": String(doc.bytes),
      "Content-Disposition": `attachment; filename="${nombre}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
});

export const DELETE = withAuthz(async (req: Request, ctx: Params) => {
  const { id, docId } = await ctx.params;
  const doc = await prisma.ordenDocumento.findFirst({
    where: { id: docId, ordenId: id },
    select: { id: true, companyId: true, tipo: true, nombre: true, orden: { select: { estado: true, folio: true } } },
  });
  if (!doc) throw new AuthzError(404, "Documento no encontrado");
  const { user } = await requireWriter(doc.companyId, req);
  await requireModule(doc.companyId, "AUTOMOTRIZ", req);

  if (doc.tipo === "CONTRATO_FIRMADO") {
    return NextResponse.json({ error: "El contrato firmado es inmutable" }, { status: 422 });
  }
  if (doc.orden.estado === "ENTREGADA" || doc.orden.estado === "CANCELADA") {
    return NextResponse.json({ error: `Una orden ${doc.orden.estado} ya no se edita` }, { status: 422 });
  }

  await prisma.ordenDocumento.delete({ where: { id: docId } });
  registrarBitacora({
    companyId: doc.companyId,
    userId: user.id,
    actorEmail: user.email,
    accion: "automotriz.orden.documento.eliminar",
    entidad: "OrdenDocumento",
    entidadId: docId,
    detalle: { ordenFolio: doc.orden.folio, tipo: doc.tipo, nombre: doc.nombre },
  });
  return NextResponse.json({ ok: true });
});
