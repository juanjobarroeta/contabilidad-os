/**
 * GET  /api/hospital/mantenimiento/[id]/fotos → { fotos: [{ id, mime, bytes, nota, createdAt }] }
 * POST /api/hospital/mantenimiento/[id]/fotos { base64, mime, nota? } → 201 foto
 *
 * La foto del reporte (lámina 18: «con foto y ubicación, en el momento en que
 * ve la falla»). El listado NUNCA devuelve los bytes — para eso está
 * /fotos/[fotoId], que los sirve con su content-type. Ver ticket-fotos.ts para
 * los topes y por qué son los que son.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, errorZod } from "@/lib/hospital/http";
import { fotoResumen, validarCupo, validarFoto } from "@/lib/hospital/ticket-fotos";

type Ctx = { params: Promise<{ id: string }> };

async function ticketDe(id: string) {
  const t = await prisma.hospTicket.findUnique({ where: { id }, select: { id: true, companyId: true, folio: true } });
  if (!t) throw new AuthzError(404, "Reporte no encontrado");
  return t;
}

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const t = await ticketDe(id);
  await requireMembership(t.companyId, undefined, req);
  await requireModule(t.companyId, "HOSPITAL", req);

  const fotos = await prisma.hospTicketFoto.findMany({
    where: { ticketId: t.id },
    select: { id: true, mime: true, bytes: true, nota: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ fotos: fotos.map(fotoResumen) });
});

const postSchema = z.object({
  /** La imagen ya encogida por el teléfono, en base64 sin el prefijo data:. */
  base64: z.string().min(1),
  mime: z.string().min(1).max(60),
  nota: z.string().trim().max(200).nullable().optional(),
});

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const t = await ticketDe(id);
  const { user } = await requireWriter(t.companyId, req);
  await requireModule(t.companyId, "HOSPITAL", req);

  // Se mide DESPUÉS de decodificar: base64 infla ~33 % y el tope es de bytes
  // reales. Un base64 mal formado sale aquí como una imagen vacía.
  const archivo = Buffer.from(d.base64, "base64");
  validarFoto(d.mime, archivo.byteLength);
  validarCupo(await prisma.hospTicketFoto.count({ where: { ticketId: t.id } }));

  const foto = await prisma.hospTicketFoto.create({
    data: {
      companyId: t.companyId,
      ticketId: t.id,
      mime: d.mime,
      bytes: archivo.byteLength,
      archivo,
      nota: d.nota ?? null,
      subidoPorUserId: user.id,
    },
    select: { id: true, mime: true, bytes: true, nota: true, createdAt: true },
  });

  bitacora(user, req, {
    companyId: t.companyId,
    accion: "hospital.mantenimiento.foto",
    entidad: "HospTicketFoto",
    entidadId: foto.id,
    detalle: { folio: t.folio, mime: foto.mime, bytes: foto.bytes },
  });
  return NextResponse.json(fotoResumen(foto), { status: 201 });
});

/** El body trae la imagen en base64, que infla ~33 %: subir seis fotos
 *  seguidas no cabe en el default de diez segundos. */
export const maxDuration = 30;
/** Buffer.from(base64) necesita Node, no el runtime de borde. */
export const runtime = "nodejs";
// OJO: aquí NO va `export const config = { api: { bodyParser } }`. Eso es del
// Pages Router; en el App Router es un «invalid segment configuration export»
// que tumba el build entero — y `tsc` no lo ve, porque como TypeScript es
// válido. El límite de cuerpo de un Route Handler no se configura: se valida
// en la ruta, que es lo que hace `validarFoto`.
