import { NextResponse } from "next/server";
import { evaluarPregunta, resumir } from "@/lib/ai/eval/copiloto-eval";
import { PREGUNTAS_EVAL } from "@/lib/ai/eval/preguntas";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/copiloto-eval   — el eval del copiloto, por páginas.
//
// Corre DENTRO de Railway porque ahí viven la KB (pgvector) y las llaves. Es
// paginado porque una corrida completa (40+ preguntas × agente + juez) no cabe
// en los 300 s de una request: el workflow pide páginas de ~8 y agrega.
//
// Body: { offset?: number, limit?: number, ids?: string[], agente?: bool, juez?: bool }
// Auth: CRON_SECRET (Bearer o x-cron-secret), como los otros admin/cron.
// Costo: todo lo del LLM cae en CostEvent subtipo "ai.eval".
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    offset?: number;
    limit?: number;
    ids?: string[];
    agente?: boolean;
    juez?: boolean;
  };
  const universo = Array.isArray(body.ids) && body.ids.length > 0
    ? PREGUNTAS_EVAL.filter((p) => body.ids!.includes(p.id))
    : PREGUNTAS_EVAL;
  const offset = Math.max(0, Number(body.offset ?? 0) || 0);
  const limit = Math.min(Math.max(1, Number(body.limit ?? 8) || 8), 20);
  const pagina = universo.slice(offset, offset + limit);

  const startedAt = Date.now();
  const resultados = [];
  for (const p of pagina) {
    // Presupuesto de tiempo: si una página se alarga, se devuelve lo hecho y el
    // caller continúa desde `siguiente`.
    if (Date.now() - startedAt > 250_000) break;
    resultados.push(await evaluarPregunta(p, { agente: body.agente !== false, juez: body.juez !== false }));
  }
  const siguiente = offset + resultados.length;
  return NextResponse.json({
    total: universo.length,
    offset,
    procesadas: resultados.length,
    siguiente,
    fin: siguiente >= universo.length,
    resumenPagina: resumir(resultados),
    resultados,
    ms: Date.now() - startedAt,
  });
}
