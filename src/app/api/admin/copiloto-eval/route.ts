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
    /** Palancas de la búsqueda a medir: { modo?: "vector"|"hibrido", rerank?: boolean }. Vacío = defaults de producción. */
    busqueda?: { modo?: "vector" | "hibrido"; rerank?: boolean };
  };
  const busqueda = {
    modo: body.busqueda?.modo === "hibrido" ? ("hibrido" as const) : body.busqueda?.modo === "vector" ? ("vector" as const) : undefined,
    rerank: typeof body.busqueda?.rerank === "boolean" ? body.busqueda.rerank : undefined,
  };
  const universo = Array.isArray(body.ids) && body.ids.length > 0
    ? PREGUNTAS_EVAL.filter((p) => body.ids!.includes(p.id))
    : PREGUNTAS_EVAL;
  const offset = Math.max(0, Number(body.offset ?? 0) || 0);
  const limit = Math.min(Math.max(1, Number(body.limit ?? 8) || 8), 20);
  const pagina = universo.slice(offset, offset + limit);

  // Railway corta la request a los 300 s (502). Con el agente real (Fable 5,
  // razonamiento siempre activo) una pregunta con juez puede tardar 60–120 s,
  // así que: (1) no se ARRANCA una pregunta nueva pasados 120 s, (2) ninguna
  // pregunta corre más de 150 s — si se pasa, queda con error "timeout" y la
  // página se devuelve igual. El workflow sigue desde `siguiente`.
  const NO_ARRANCAR_DESPUES_MS = 120_000;
  const TOPE_POR_PREGUNTA_MS = 150_000;
  const startedAt = Date.now();
  const resultados = [];
  for (const p of pagina) {
    if (Date.now() - startedAt > NO_ARRANCAR_DESPUES_MS) break;
    const conTope = await Promise.race([
      evaluarPregunta(p, { agente: body.agente !== false, juez: body.juez !== false, busqueda }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TOPE_POR_PREGUNTA_MS)),
    ]);
    resultados.push(
      conTope ?? {
        id: p.id,
        tema: p.tema,
        pregunta: p.pregunta,
        fundamentos: p.fundamentos,
        recuperacion: { hit: false, citas: [] },
        error: `timeout (> ${TOPE_POR_PREGUNTA_MS / 1000} s)`,
      }
    );
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
