/**
 * POST /api/hospital/episodios/[id]/notas/[notaId]/firma { imagen (data URL PNG ≤ 300 KB) }
 *      → el autor firma su nota sellada con su trazo (firma electrónica
 *        simple): firmaHash = sha256(trazo|hash de la nota|AUTOR|autor|fecha),
 *        IP y user agent. Una sola vez; no se edita ni se borra.
 *   400 trazo inválido · 403 no es el autor · 404 · 409 ya firmada, sustituida o sello roto
 *
 * GET  …/firma → el trazo y su evidencia para imprimir la nota
 *      ({ firmada, imagen, firmaHash, firmadaAt, hashVerificado }).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { ipDeRequest } from "@/lib/audit";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { firmarNota, verificarFirmaNota } from "@/lib/hospital/nota-firma";

type Ctx = { params: Promise<{ id: string; notaId: string }> };

const schema = z.object({ imagen: z.string().min(1).max(450_000) });

async function episodio(id: string) {
  const ep = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true, folio: true } });
  if (!ep) throw new AuthzError(404, "Episodio no encontrado");
  return ep;
}

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id, notaId } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);

  const ep = await episodio(id);
  const { user } = await requireWriter(ep.companyId, req);
  await requireModule(ep.companyId, "HOSPITAL", req);

  const r = await firmarNota(prisma, {
    episodioId: ep.id,
    notaId,
    imagen: parsed.data.imagen,
    ip: ipDeRequest(req),
    userAgent: req.headers.get("user-agent"),
    userId: user.id,
  });

  bitacora(user, req, {
    companyId: ep.companyId,
    accion: "hospital.nota.firmar",
    entidad: "HospNota",
    entidadId: r.id,
    detalle: { folio: ep.folio, hashNota: r.hashNota, firmaHash: r.firmaHash },
  });

  return NextResponse.json({ id: r.id, firmada: true, firmaHash: r.firmaHash, firmadaAt: r.firmadaAt }, { status: 201 });
});

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id, notaId } = await ctx.params;
  const ep = await episodio(id);
  await requireMembership(ep.companyId, undefined, req);
  await requireModule(ep.companyId, "HOSPITAL", req);

  const n = await prisma.hospNota.findUnique({
    where: { id: notaId },
    select: { episodioId: true, hash: true, autorNombre: true, firmaImagen: true, firmaHash: true, firmadaAt: true },
  });
  if (!n || n.episodioId !== ep.id) return error("Nota no encontrada", 404);
  return NextResponse.json({
    firmada: !!n.firmadaAt,
    imagen: n.firmaImagen,
    firmaHash: n.firmaHash,
    firmadaAt: n.firmadaAt,
    hashVerificado: verificarFirmaNota(n),
  });
});
