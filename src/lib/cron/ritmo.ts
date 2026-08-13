// ─────────────────────────────────────────────────────────────────────────────
// Ritmo ADAPTATIVO del pipeline: cada cuánto vuelve a correr un trabajo según
// lo que acaba de reportar.
//
// El scheduler de intervalos fijos tenía un defecto simple: el trabajo espera
// su tick aunque el servidor esté ocioso. Un rezago de 212 mil facturas
// drenaba en 26 días a 2 mil cada 6 horas — no porque fuera caro (200 filas por
// segundo, puramente local), sino porque nadie lo volvía a llamar. La cadencia
// fija también obliga a codificar el orden del pipeline como desfases de
// arranque, en vez de encadenar por evento.
//
// La corrección NO es una cola de mensajes: nuestros trabajos ya son
// idempotentes y gap-driven — su lista de pendientes ES el estado de la BD, no
// un payload. Lo que faltaba es que, cuando un trabajo reporta que le quedó
// pendiente, se vuelva a llamar EN SEGUNDOS en vez de en horas; y que cuando
// queda ocioso, regrese a su cadencia base sin gastar.
//
// La palanca de seguridad es el PISO por trabajo: los que hablan con el SAT
// conservan un piso alto para no atropellar sus cuotas ni sus límites; los
// locales (parsear XML ya guardado, derivar impuestos) pueden ir seguidos.
//
// PURO: decide a partir del status HTTP y del cuerpo de la respuesta.
// ─────────────────────────────────────────────────────────────────────────────

/** Llaves con las que los crons reportan trabajo PENDIENTE al terminar. */
const LLAVES_PENDIENTE = [
  "restantes",
  "pendientes",
  "periodosPendientes",
  "empresasCargando",
] as const;

/** Llaves con las que reportan trabajo REALIZADO en la corrida. */
const LLAVES_HECHO = [
  "actualizadas",
  "imported",
  "importados",
  "checked",
  "procesadas",
  "nuevos",
  "derivados",
  "derivadas",
  "cancelledDetected",
  "totalSubmitted",
  "totalImported",
  "sintesisGeneradas",
  "histPeriodos",
] as const;

export type CuerpoCorrida = Record<string, unknown> | null | undefined;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * ¿Quedó trabajo pendiente? true/false cuando el cron lo reporta explícitamente;
 * null cuando no dice nada (no todos los crons llevan la cuenta).
 */
export function hayTrabajoPendiente(cuerpo: CuerpoCorrida): boolean | null {
  if (!cuerpo) return null;
  // `completado` es la señal más explícita (barridos con cursor durable).
  if (typeof cuerpo.completado === "boolean") return !cuerpo.completado;
  let visto = false;
  for (const k of LLAVES_PENDIENTE) {
    const n = num(cuerpo[k]);
    if (n != null) {
      visto = true;
      if (n > 0) return true;
    }
  }
  return visto ? false : null;
}

/** ¿La corrida movió algo? (para encadenar y para acelerar sin señal explícita) */
export function hizoTrabajo(cuerpo: CuerpoCorrida): boolean {
  if (!cuerpo) return false;
  for (const k of LLAVES_HECHO) {
    const n = num(cuerpo[k]);
    if (n != null && n > 0) return true;
  }
  // Listas no vacías (p. ej. `cancelados: [...]`, `atendidas: [...]`).
  for (const k of ["cancelados", "atendidas", "empujes"]) {
    const v = cuerpo[k];
    if (Array.isArray(v) && v.length > 0) return true;
  }
  return false;
}

export interface OpcionesRitmo {
  /** Cadencia de reposo: cuando no hay nada que hacer. */
  baseMs: number;
  /** Piso: nunca se vuelve a llamar antes de esto (protege cuotas del SAT). */
  minMs: number;
}

export interface SeñalCorrida {
  /** Status HTTP de la corrida (0 si la llamada ni siquiera salió). */
  status: number;
  cuerpo?: CuerpoCorrida;
}

/** Espera cuando el trabajo dice que le quedó pendiente (acotada por el piso). */
export const ESPERA_DRENADO_MS = 15_000;
/** Espera cuando hubo trabajo pero nadie reportó pendientes. */
export const ESPERA_TIBIA_MS = 2 * 60_000;
/** Espera tras un error: no se atropella un endpoint que está fallando. */
export const ESPERA_ERROR_MS = 5 * 60_000;
/** Espera cuando otra corrida tiene el candado (409). */
export const ESPERA_OCUPADO_MS = 60_000;

/**
 * Cuánto esperar antes de volver a correr este trabajo.
 *
 * Orden de decisión:
 *  1. Error de red/HTTP → backoff (nunca por debajo de la base, para no
 *     insistirle a algo roto).
 *  2. 409 (otra corrida tiene el candado) → reintento corto: el candado se
 *     libera solo y no queremos perder el turno hasta la próxima cadencia.
 *  3. Quedó pendiente → drenado rápido (piso del trabajo manda).
 *  4. Hubo trabajo, sin señal de pendiente → espera tibia.
 *  5. Ocioso → cadencia base.
 */
export function siguienteEspera(señal: SeñalCorrida, opts: OpcionesRitmo): number {
  const piso = Math.max(1_000, opts.minMs);
  const base = Math.max(piso, opts.baseMs);

  if (señal.status === 0 || señal.status >= 500 || (señal.status >= 400 && señal.status !== 409)) {
    return Math.max(base, ESPERA_ERROR_MS);
  }
  if (señal.status === 409) return Math.max(piso, Math.min(base, ESPERA_OCUPADO_MS));

  const pendiente = hayTrabajoPendiente(señal.cuerpo);
  if (pendiente === true) return Math.max(piso, ESPERA_DRENADO_MS);
  if (pendiente === false) return base;

  return hizoTrabajo(señal.cuerpo) ? Math.max(piso, Math.min(base, ESPERA_TIBIA_MS)) : base;
}
