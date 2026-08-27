import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/automotriz/ordenes/[id]/documentos — el expediente binario de
// la orden: fotos del checkup y el contrato de adhesión firmado.
//
// El archivo viaja como base64 dentro de JSON (el apiFetch del satélite sólo
// habla JSON) y se decodifica UNA vez aquí. Las listas jamás leen el blob
// (`bytes` desnormalizado). El CONTRATO_FIRMADO es INMUTABLE: uno solo, sólo
// PDF, no se borra, y su subida fija `firmadoAt` en la misma transacción —
// la firma vale porque vive DENTRO del documento que se firmó.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FOTOS = 10;
const MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;

const metaSelect = { id: true, tipo: true, nombre: true, mime: true, bytes: true, createdAt: true } as const;

export const GET = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const orden = await prisma.ordenServicio.findUnique({ where: { id }, select: { companyId: true } });
  if (!orden) throw new AuthzError(404, "Orden no encontrada");
  await requireMembership(orden.companyId, undefined, req);
  await requireModule(orden.companyId, "AUTOMOTRIZ", req);

  const documentos = await prisma.ordenDocumento.findMany({
    where: { ordenId: id },
    select: metaSelect,
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ documentos });
});

const createSchema = z.object({
  tipo: z.enum(["FOTO_RECEPCION", "CONTRATO_FIRMADO", "OTRO"]),
  nombre: z.string().min(1).max(140),
  mime: z.enum(MIMES),
  base64: z.string().min(1).max(Math.ceil((MAX_BYTES * 4) / 3) + 4),
});

export const POST = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  const orden = await prisma.ordenServicio.findUnique({
    where: { id },
    select: { companyId: true, estado: true, folio: true },
  });
  if (!orden) throw new AuthzError(404, "Orden no encontrada");
  const { user } = await requireWriter(orden.companyId, req);
  await requireModule(orden.companyId, "AUTOMOTRIZ", req);

  if (orden.estado === "ENTREGADA" || orden.estado === "CANCELADA") {
    return NextResponse.json({ error: `Una orden ${orden.estado} ya no recibe documentos` }, { status: 422 });
  }

  const buf = Buffer.from(d.base64, "base64");
  if (buf.length === 0) return NextResponse.json({ error: "Archivo vacío" }, { status: 400 });
  if (buf.length > MAX_BYTES) {
    return NextResponse.json(
      { error: `El archivo pesa ${(buf.length / 1024 / 1024).toFixed(1)} MB; el máximo es 8 MB` },
      { status: 413 }
    );
  }

  if (d.tipo === "FOTO_RECEPCION") {
    const fotos = await prisma.ordenDocumento.count({ where: { ordenId: id, tipo: "FOTO_RECEPCION" } });
    if (fotos >= MAX_FOTOS) {
      return NextResponse.json({ error: `Máximo ${MAX_FOTOS} fotos por orden` }, { status: 422 });
    }
  }

  let creado;
  if (d.tipo === "CONTRATO_FIRMADO") {
    if (d.mime !== "application/pdf") {
      return NextResponse.json({ error: "El contrato firmado debe ser PDF" }, { status: 422 });
    }
    const existente = await prisma.ordenDocumento.count({ where: { ordenId: id, tipo: "CONTRATO_FIRMADO" } });
    if (existente > 0) {
      return NextResponse.json({ error: "La orden ya tiene su contrato firmado — es inmutable" }, { status: 422 });
    }
    // El contrato y el sello de firmado caen JUNTOS: firmadoAt sólo existe si
    // el PDF firmado existe, y nunca al revés.
    creado = await prisma.$transaction(async (tx) => {
      const doc = await tx.ordenDocumento.create({
        data: { companyId: orden.companyId, ordenId: id, tipo: d.tipo, nombre: d.nombre, mime: d.mime, bytes: buf.length, datos: buf },
        select: metaSelect,
      });
      await tx.ordenServicio.update({ where: { id }, data: { firmadoAt: new Date() } });
      return doc;
    });
  } else {
    creado = await prisma.ordenDocumento.create({
      data: { companyId: orden.companyId, ordenId: id, tipo: d.tipo, nombre: d.nombre, mime: d.mime, bytes: buf.length, datos: buf },
      select: metaSelect,
    });
  }

  registrarBitacora({
    companyId: orden.companyId,
    userId: user.id,
    actorEmail: user.email,
    accion: "automotriz.orden.documento",
    entidad: "OrdenDocumento",
    entidadId: creado.id,
    detalle: { ordenFolio: orden.folio, tipo: d.tipo, nombre: d.nombre, bytes: buf.length },
  });
  return NextResponse.json(creado, { status: 201 });
});
