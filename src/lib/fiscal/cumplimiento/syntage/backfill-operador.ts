// ─────────────────────────────────────────────────────────────────────────────
// Corridas del backfill de declaraciones lanzadas por el operador, EN SEGUNDO
// PLANO.
//
// Por qué: el botón "Ingresar declaraciones previas" esperaba la respuesta
// completa. Una empresa con 9–12 acuses tarda 2–4 min (una llamada a Claude
// por PDF) y Safari móvil corta a los ~2.5 min: la corrida seguía en el
// servidor pero el operador nunca vio el resultado (FRC ABOGADOS, 3-sep-2026:
// 499 tras 163 s, y el redeploy siguiente mató la corrida a medias).
//
// Ahora POST arranca la corrida y responde al instante; la página sondea GET.
// El estado vive EN MEMORIA del proceso (globalThis, sobrevive HMR): si el
// proceso muere (redeploy) la corrida se pierde — pero las filas ya creadas
// persisten (cada acuse escribe al parsearlo) y re-correr es gap-fill, así
// que la página muestra "sin corrida en curso" y el operador vuelve a pulsar.
// ─────────────────────────────────────────────────────────────────────────────

import { backfillDeclaracionesMensuales, type AvanceBackfill } from "./declaraciones-backfill";

export type EstadoCorrida = "corriendo" | "terminado" | "error";

export interface CorridaBackfill {
  companyId: string;
  estado: EstadoCorrida;
  inicio: string;
  fin: string | null;
  maxAcuses: number;
  acusesParseados: number;
  mesesCreados: number;
  ultimoPeriodo: string | null;
  topeAlcanzado: boolean;
  error: string | null;
}

/**
 * Una corrida "corriendo" más vieja que esto se considera colgada y se deja
 * reemplazar (el motor tiene maxDuration=300 s por ruta, pero aquí corre fuera
 * de la ruta; 20 min es holgado para 60 acuses).
 */
export const TTL_CORRIDA_MS = 20 * 60_000;

const FLAG = Symbol.for("contabilidad-os.backfill-operador");

function registro(): Map<string, CorridaBackfill> {
  const g = globalThis as Record<symbol, Map<string, CorridaBackfill> | undefined>;
  return (g[FLAG] ??= new Map());
}

/** ¿Hay una corrida en curso que impide arrancar otra para la empresa? (PURA) */
export function bloqueaNuevaCorrida(existente: CorridaBackfill | null | undefined, ahora: Date): boolean {
  if (!existente || existente.estado !== "corriendo") return false;
  return ahora.getTime() - new Date(existente.inicio).getTime() < TTL_CORRIDA_MS;
}

export function corridaDe(companyId: string): CorridaBackfill | null {
  return registro().get(companyId) ?? null;
}

/**
 * Arranca el backfill en segundo plano. Si ya hay una corrida vigente devuelve
 * ésa con `iniciada: false` (idempotente ante doble clic).
 */
export function iniciarCorrida(
  companyId: string,
  maxAcuses: number,
  correr: typeof backfillDeclaracionesMensuales = backfillDeclaracionesMensuales,
): { iniciada: boolean; corrida: CorridaBackfill } {
  const previa = corridaDe(companyId);
  if (bloqueaNuevaCorrida(previa, new Date())) return { iniciada: false, corrida: previa! };

  const corrida: CorridaBackfill = {
    companyId,
    estado: "corriendo",
    inicio: new Date().toISOString(),
    fin: null,
    maxAcuses,
    acusesParseados: 0,
    mesesCreados: 0,
    ultimoPeriodo: null,
    topeAlcanzado: false,
    error: null,
  };
  registro().set(companyId, corrida);

  const onAvance = (a: AvanceBackfill) => {
    corrida.acusesParseados = a.acusesParseados;
    corrida.mesesCreados = a.mesesCreados;
    corrida.ultimoPeriodo = a.ultimoPeriodo;
  };

  void correr(companyId, undefined, { maxAcuses, onAvance })
    .then((r) => {
      corrida.acusesParseados = r.acusesParseados;
      corrida.mesesCreados = r.mesesCreados;
      corrida.topeAlcanzado = r.topeAlcanzado === true;
      corrida.error = r.error ?? null;
      corrida.estado = r.error ? "error" : "terminado";
      corrida.fin = new Date().toISOString();
      console.log(
        `[backfill-operador] ${r.rfc ?? companyId}: acuses=${r.acusesParseados} meses=${r.mesesCreados}` +
          `${corrida.topeAlcanzado ? " tope" : ""}${r.error ? ` error=${r.error}` : ""}`,
      );
    })
    .catch((e) => {
      corrida.error = e instanceof Error ? e.message : String(e);
      corrida.estado = "error";
      corrida.fin = new Date().toISOString();
      console.error(`[backfill-operador] ${companyId}: ${corrida.error}`);
    });

  return { iniciada: true, corrida };
}
