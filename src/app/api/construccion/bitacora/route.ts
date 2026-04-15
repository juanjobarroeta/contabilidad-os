/**
 * GET  /api/construccion/bitacora?proyectoId=...&limit=20&offset=0
 * POST /api/construccion/bitacora
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const createSchema = z.object({
  proyectoId: z.string().min(1),
  texto: z.string().min(1),
  tipo: z.enum(["NOTA", "DECISION", "PROBLEMA", "CLIMA", "FOTO"]).optional().default("NOTA"),
  fecha: z.string().datetime().optional(),
  presupuestoPartidaId: z.string().optional(),
  fotos: z.array(z.string().url()).optional(),
});

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const proyectoId = searchParams.get("proyectoId");
  if (!proyectoId) return NextResponse.json({ error: "proyectoId requerido" }, { status: 400 });

  const proy = await prisma.proyecto.findUnique({ where: { id: proyectoId }, select: { companyId: true } });
  if (!proy) return NextResponse.json({ error: "Proyecto no encontrado" }, { status: 404 });

  await requireMembership(proy.companyId, undefined, req);
  await requireModule(proy.companyId, "CONSTRUCCION");

  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50"), 200);
  const offset = parseInt(searchParams.get("offset") ?? "0");

  const entries = await prisma.bitacoraEntrada.findMany({
    where: { proyectoId },
    include: {
      presupuestoPartida: {
        select: { zona: true, partida: true, concepto: { select: { codigo: true, descripcion: true } } },
      },
    },
    orderBy: { fecha: "desc" },
    take: limit,
    skip: offset,
  });

  return NextResponse.json(entries);
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const proy = await prisma.proyecto.findUnique({ where: { id: parsed.data.proyectoId }, select: { companyId: true } });
  if (!proy) return NextResponse.json({ error: "Proyecto no encontrado" }, { status: 404 });

  await requireWriter(proy.companyId, req);
  await requireModule(proy.companyId, "CONSTRUCCION");

  const entry = await prisma.bitacoraEntrada.create({
    data: {
      proyectoId: parsed.data.proyectoId,
      texto: parsed.data.texto,
      tipo: parsed.data.tipo,
      fecha: parsed.data.fecha ? new Date(parsed.data.fecha) : new Date(),
      presupuestoPartidaId: parsed.data.presupuestoPartidaId,
      fotos: parsed.data.fotos ?? [],
    },
  });

  return NextResponse.json(entry, { status: 201 });
});
