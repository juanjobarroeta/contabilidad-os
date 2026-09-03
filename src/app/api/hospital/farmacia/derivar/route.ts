import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import {
  conteosDerivacion,
  derivarInsumosBackfill,
  leerProgresoInsumos,
} from "@/lib/hospital/insumos-cfdi";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/hospital/farmacia/derivar   { companyId }
//
// Poblar farmacia desde el archivo de CFDIs (paso 4 del alta de una empresa).
// POST corre UNA pasada acotada (~20 s) del drenado por cursor y devuelve
// hasta dónde llegó; el satélite la encadena mientras `completado` sea false
// (o lo deja al cron nocturno hospital-insumos-backfill, que retoma el mismo
// cursor). GET enseña el progreso y cuánto del catálogo/kardex nació de ahí.
// Idempotente: repetir no duplica nada.
// ─────────────────────────────────────────────────────────────────────────────

const BUDGET_MS = 20_000;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const [progreso, conteos, candidatas] = await Promise.all([
    leerProgresoInsumos(prisma, companyId),
    conteosDerivacion(prisma, companyId),
    prisma.invoice.count({ where: { companyId, tipo: { in: ["INGRESO", "EGRESO"] }, status: { not: "CANCELLED" } } }),
  ]);
  return NextResponse.json({ companyId, progreso, ...conteos, cfdisCandidatos: candidatas });
});

const schema = z.object({ companyId: z.string().min(1) });

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  const { companyId } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  const resultado = await derivarInsumosBackfill(prisma, companyId, { budgetMs: BUDGET_MS, page: 100 });
  const [progreso, conteos] = await Promise.all([
    leerProgresoInsumos(prisma, companyId),
    conteosDerivacion(prisma, companyId),
  ]);

  registrarBitacora({
    companyId,
    userId: user.id,
    actorEmail: user.email,
    accion: "hospital.insumos.derivar",
    entidad: "BackfillProgreso",
    entidadId: null,
    detalle: { procesados: resultado.procesados, insumos: resultado.insumos, movimientos: resultado.movimientos, completado: resultado.completado },
    req,
  });

  return NextResponse.json({ ok: true, companyId, ...resultado, progreso, ...conteos });
});
