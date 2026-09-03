import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import {
  backfillAllDeclaracionesMensuales,
  backfillDeclaracionesMensuales,
} from "@/lib/fiscal/cumplimiento/syntage/declaraciones-backfill";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/declaraciones-backfill   [?companyId=<id>]
//
// Rellena las declaraciones MENSUALES faltantes: descarga el acuse PDF de cada
// tax-return mensual de Syntage y lo parsea con Claude para el desglose IVA/ISR
// (que el recurso estructurado no trae). COSTOSO (1 llamada a Claude por mes sin
// capturar) — por eso es un job aparte, no el sync diario. Gap-fill + resumible:
// re-correr continúa donde quedó. Auth: CRON_SECRET.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

/**
 * Señal para el ritmo adaptativo del scheduler (lib/cron/ritmo.ts). El cuerpo
 * original (`acusesParseados`, `topeAlcanzado`) no usa ninguna de las llaves que
 * el scheduler reconoce, así que una corrida que se cortaba por el tope de 10
 * acuses dormía 6 h como si no quedara nada — con ~20 empresas y un tope
 * compartido, una empresa recién extraída en Syntage podía tardar días en
 * recibir sus acuses (caso FRC ABOGADOS, sep-2026). `completado=false` hace que
 * vuelva al piso del job (15 min, MIN_CARO) hasta drenar el pendiente.
 */
function señalRitmo(acusesParseados: number, topeAlcanzado: boolean) {
  return { completado: !topeAlcanzado, procesadas: acusesParseados };
}

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const only = sp.get("companyId");
  // Chunk acotado por corrida (evita timeouts): default 10 acuses. ?max=0 = sin tope.
  const maxParam = parseInt(sp.get("max") ?? "10");
  const maxAcuses = Number.isFinite(maxParam) && maxParam > 0 ? maxParam : undefined;
  try {
    if (only) {
      const r = await backfillDeclaracionesMensuales(only, undefined, { maxAcuses });
      console.log(
        `[declaraciones-backfill] ${r.rfc ?? only}: acuses=${r.acusesParseados} meses=${r.mesesCreados}` +
          `${r.topeAlcanzado ? " tope" : ""}${r.error ? ` error=${r.error}` : ""}`,
      );
      return NextResponse.json({ ok: true, ...r, ...señalRitmo(r.acusesParseados, r.topeAlcanzado === true) });
    }
    const r = await backfillAllDeclaracionesMensuales({ maxAcuses });
    // Resumen en el log de Railway: antes una corrida exitosa no dejaba rastro
    // (el scheduler sólo loguea errores HTTP), así que no había forma de saber si
    // el job llegó a una empresa o se quedó sin presupuesto antes.
    const conMovimiento = r.resultados.filter(
      (x) => x.acusesParseados > 0 || x.mesesCreados > 0 || x.error || (x.errores ?? 0) > 0,
    );
    console.log(
      `[declaraciones-backfill] empresas=${r.empresas} acuses=${r.acusesParseados} meses=${r.mesesCreados}` +
        ` errores=${r.errores}${r.topeAlcanzado ? " tope" : ""}` +
        (conMovimiento.length
          ? " · " +
            conMovimiento
              .map(
                (x) =>
                  `${x.rfc ?? x.companyId}:${x.acusesParseados}/${x.mesesCreados}` +
                  `${(x.errores ?? 0) > 0 ? `/${x.errores}fallos(${x.primerError})` : ""}${x.error ? `!${x.error}` : ""}`,
              )
              .join(" ")
          : ""),
    );
    return NextResponse.json({ ok: true, ...r, ...señalRitmo(r.acusesParseados, r.topeAlcanzado) });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

export async function POST(req: Request) {
  return withCronLock("cron:declaraciones-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:declaraciones-backfill", () => handle(req));
}
