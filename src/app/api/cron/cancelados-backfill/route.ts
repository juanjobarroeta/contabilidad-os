import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { empresasElegibles } from "@/lib/agenda-sat/ejecutar";
import { satGoConfigurado } from "@/lib/fiscal/cumplimiento/satgo/client";
import { importarCanceladosSatGo, JOB } from "@/lib/fiscal/cumplimiento/satgo/cancelados";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/cancelados-backfill   [?companyId=&historicas=N]
//
// CFDIs cancelados en el SAT que la descarga masiva nunca trae (pide sólo
// «active»): se listan por SatGo (facfiel, estatus cancelado) por semestre,
// se cancelan los que teníamos como vigentes y se crean como CANCELLED «de
// listado» los que nunca se bajaron. Las dos ventanas más recientes se
// re-piden en cada corrida; las históricas una vez (BackfillProgreso).
// Acotado: 3 empresas × 2 ventanas históricas por corrida (4 llamadas a
// SatGo por ventana+lado, 10–30 s cada una). Auth: CRON_SECRET.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_EMPRESAS = 3;
const TIME_BUDGET_MS = 230_000;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!satGoConfigurado()) return NextResponse.json({ ok: false, error: "SATGO_API_KEY no configurada" }, { status: 503 });
  const url = new URL(req.url);
  const onlyCompanyId = url.searchParams.get("companyId");
  const hParam = parseInt(url.searchParams.get("historicas") ?? "", 10);
  const maxHistoricas = Number.isFinite(hParam) ? Math.min(Math.max(hParam, 0), 10) : 2;
  const startedAt = Date.now();

  const elegibles = await empresasElegibles();
  const candidatas = onlyCompanyId ? elegibles.filter((c) => c.id === onlyCompanyId) : elegibles;
  // Primero las que nunca han corrido, luego las incompletas, luego el resto (ventanas vivas).
  const progreso = await prisma.backfillProgreso.findMany({ where: { job: JOB, companyId: { in: candidatas.map((c) => c.id) } }, select: { companyId: true, completadoAt: true, updatedAt: true } });
  const estado = new Map(progreso.map((p) => [p.companyId, p]));
  const orden = [...candidatas].sort((a, b) => {
    const pa = estado.get(a.id), pb = estado.get(b.id);
    const ra = !pa ? 0 : !pa.completadoAt ? 1 : 2, rb = !pb ? 0 : !pb.completadoAt ? 1 : 2;
    return ra - rb || (pa?.updatedAt.getTime() ?? 0) - (pb?.updatedAt.getTime() ?? 0);
  });

  const resultados: Array<Record<string, unknown>> = [];
  for (const c of orden.slice(0, onlyCompanyId ? 1 : MAX_EMPRESAS)) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    try {
      const r = await importarCanceladosSatGo(c.id, { maxHistoricas });
      resultados.push({ rfc: r.rfc, pendientes: r.pendientes, completo: r.completo, ventanas: r.ventanas });
    } catch (e) {
      resultados.push({ rfc: c.rfc, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  const summary = { ok: true, empresasElegibles: elegibles.length, atendidas: resultados.length, resultados, elapsedMs: Date.now() - startedAt };
  console.log("[cron/cancelados-backfill] done:", JSON.stringify(summary).slice(0, 1500));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:cancelados-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:cancelados-backfill", () => handle(req));
}
