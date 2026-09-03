// ─────────────────────────────────────────────────────────────────────────────
// Seguimiento de extracciones Syntage: cosechar EN CUANTO terminan.
//
// Aprovisionar dispara extracciones asíncronas (opinión, CSF, anuales,
// mensuales, CE). Antes el resultado lo recogían los crons de cadencia —
// compliance-sync y declaraciones-backfill cada 6 h — así que una empresa
// recién onboardeada veía sus declaraciones hasta 12 h después de que Syntage
// ya las tenía (caso FRC ABOGADOS, sep-2026: Syntage con 12 mensuales el día
// 2, la app sin ninguna el día 3). Los redeploys empeoran el cuadro: cada uno
// reinicia el reloj del scheduler.
//
// Aquí, tras disparar, se sondea cada extracción y al terminar se corre el cron
// que la cosecha ACOTADO A ESA EMPRESA:
//   • monthly_tax_return → declaraciones-backfill?companyId=X&max=25 (en bucle
//     hasta `completado`, para no chocar con el tope compartido de 10).
//   • tax_compliance / tax_status / annual_tax_return / electronic_accounting →
//     compliance-sync?companyId=X.
//
// Fire-and-forget dentro del servidor (Railway siempre encendido), con timers
// `unref` como kickCron. Si el proceso muere a medias (redeploy), la cadencia
// del scheduler sigue siendo la red de seguridad — por eso ésta no se quita.
// ─────────────────────────────────────────────────────────────────────────────

import { correrCron } from "@/lib/cron-scheduler";
import { SyntageClient, type EstadoExtraccion, type Extractor } from "./client";

const MIN = 60_000;

export interface ExtraccionDisparada {
  extractor: Extractor;
  id: string;
}

export interface CronSeguimiento {
  name: string;
  query: string;
}

/** Tiempo máximo de sondeo por empresa; después la cosecha queda a la cadencia. */
export const TOPE_SEGUIMIENTO_MS = 3 * 60 * MIN;

/** Tope de acuses por llamada al backfill acotado (cabe en maxDuration=300 s). */
export const MAX_ACUSES_POR_LLAMADA = 25;

/** Vueltas máximas del backfill acotado en un mismo seguimiento (25 × 12 = 300 acuses). */
const MAX_VUELTAS_BACKFILL = 12;

/** Reintentos cuando otra corrida tiene el candado (409). */
const MAX_REINTENTOS_CANDADO = 10;

const ESTADOS_FINALES: ReadonlySet<string> = new Set<EstadoExtraccion>([
  "finished",
  "failed",
  "stopped",
  "cancelled",
]);

/** ¿La extracción ya no va a cambiar de estado? (PURA) */
export function esEstadoFinal(status: string): boolean {
  return ESTADOS_FINALES.has(status);
}

/**
 * Qué cron cosecha el resultado de cada extractor, acotado a la empresa. (PURA)
 * `null` para extractores que no cosecha ningún cron de aquí (invoice,
 * tax_retention: van por otros flujos).
 */
export function cronParaExtractor(extractor: Extractor, companyId: string): CronSeguimiento | null {
  const q = `companyId=${encodeURIComponent(companyId)}`;
  switch (extractor) {
    case "monthly_tax_return":
      return { name: "declaraciones-backfill", query: `${q}&max=${MAX_ACUSES_POR_LLAMADA}` };
    case "tax_compliance":
    case "tax_status":
    case "annual_tax_return":
    case "electronic_accounting":
      return { name: "compliance-sync", query: q };
    default:
      return null;
  }
}

/**
 * Espera entre sondeos según lo transcurrido: los primeros minutos se sondea
 * seguido (opinión/CSF terminan en segundos), después una vez por minuto (las
 * mensuales de 5 ejercicios pueden tardar bastante). (PURA)
 */
export function intervaloSondeo(transcurridoMs: number): number {
  if (transcurridoMs < 2 * MIN) return 15_000;
  if (transcurridoMs < 15 * MIN) return 30_000;
  return MIN;
}

/**
 * Colapsa las extracciones terminadas en la lista de crons a correr, sin
 * repetir un cron (anual + opinión + CSF terminadas juntas → UN compliance-sync). (PURA)
 */
export function cronsParaTerminadas(terminadas: Extractor[], companyId: string): CronSeguimiento[] {
  const porNombre = new Map<string, CronSeguimiento>();
  for (const ex of terminadas) {
    const c = cronParaExtractor(ex, companyId);
    if (c && !porNombre.has(c.name)) porNombre.set(c.name, c);
  }
  return [...porNombre.values()];
}

function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
}

function resumen(cuerpo: Record<string, unknown> | null | undefined): string {
  if (!cuerpo) return "sin cuerpo";
  const llaves = ["acusesParseados", "mesesCreados", "completado", "error", "opinion", "csf", "declaracionesAnuales"];
  const parte: Record<string, unknown> = {};
  for (const k of llaves) if (k in cuerpo) parte[k] = cuerpo[k];
  const s = JSON.stringify(parte);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/** Corre un cron acotado; si reporta `completado=false` lo vuelve a llamar. */
async function correrHastaDrenar(c: CronSeguimiento, etiqueta: string): Promise<void> {
  let vueltas = 0;
  let candado = 0;
  for (;;) {
    const señal = await correrCron(c.name, c.query);
    if (señal.status === 409) {
      // Otra corrida (la global del scheduler) tiene el candado: esperar y reintentar.
      if (++candado > MAX_REINTENTOS_CANDADO) {
        console.warn(`${etiqueta}: ${c.name} ocupado ${candado} veces; lo cosecha la cadencia.`);
        return;
      }
      await dormir(MIN);
      continue;
    }
    if (señal.status !== 200) {
      console.error(`${etiqueta}: ${c.name} HTTP ${señal.status} ${resumen(señal.cuerpo)}`);
      return;
    }
    console.log(`${etiqueta}: ${c.name} → ${resumen(señal.cuerpo)}`);
    if (señal.cuerpo?.completado === false && ++vueltas < MAX_VUELTAS_BACKFILL) {
      await dormir(5_000);
      continue;
    }
    return;
  }
}

async function bucle(
  companyId: string,
  rfc: string,
  extracciones: ExtraccionDisparada[],
  client: SyntageClient,
): Promise<void> {
  const etiqueta = `[syntage-seguimiento] ${rfc}`;
  const t0 = Date.now();
  const pendientes = new Map(extracciones.map((e) => [e.id, e.extractor] as const));
  console.log(`${etiqueta}: siguiendo ${pendientes.size} extracción(es): ${[...pendientes.values()].join(", ")}`);

  while (pendientes.size > 0) {
    const transcurrido = Date.now() - t0;
    if (transcurrido > TOPE_SEGUIMIENTO_MS) {
      console.warn(
        `${etiqueta}: ${[...pendientes.values()].join(", ")} sin terminar tras ${Math.round(transcurrido / MIN)} min; ` +
          "lo cosecha la cadencia del scheduler.",
      );
      return;
    }
    await dormir(intervaloSondeo(transcurrido));

    const terminadas: Extractor[] = [];
    for (const [id, extractor] of pendientes) {
      let status: EstadoExtraccion;
      try {
        status = (await client.getExtraction(id)).status;
      } catch (e) {
        console.error(`${etiqueta}: sondeo ${extractor} falló — ${e instanceof Error ? e.message : String(e)}`);
        continue; // red/API: se reintenta en el siguiente sondeo
      }
      if (!esEstadoFinal(status)) continue;
      pendientes.delete(id);
      const min = ((Date.now() - t0) / MIN).toFixed(1);
      if (status === "finished") {
        terminadas.push(extractor);
        console.log(`${etiqueta}: ${extractor} terminó en ${min} min`);
      } else {
        console.warn(`${etiqueta}: ${extractor} terminó ${status} a los ${min} min`);
      }
    }

    for (const c of cronsParaTerminadas(terminadas, companyId)) {
      await correrHastaDrenar(c, etiqueta);
    }
  }
}

/**
 * Arranca el seguimiento (fire-and-forget). Sin CRON_SECRET (dev sin scheduler)
 * o sin extracciones no hace nada.
 */
export function seguirExtracciones(
  companyId: string,
  rfc: string,
  extracciones: ExtraccionDisparada[],
  client: SyntageClient = new SyntageClient(),
): void {
  if (!process.env.CRON_SECRET || extracciones.length === 0) return;
  void bucle(companyId, rfc, extracciones, client).catch((e) => {
    console.error(`[syntage-seguimiento] ${rfc}: abortado — ${e instanceof Error ? e.message : String(e)}`);
  });
}
