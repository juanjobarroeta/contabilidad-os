// ─────────────────────────────────────────────────────────────────────────────
// Scheduler EN-PROCESO del pipeline de datos (Railway, sin GitHub Actions).
//
// Los crons del pipeline (backfill/sync SAT, aprovisionamiento Syntage) corrían
// SOLO como workflows de GitHub Actions. Cuando Actions se cae (p. ej. billing,
// jul-2026: 3 días sin corridas), el producto deja de cumplir su promesa: un
// cliente recién onboardeado espera ver sus CFDIs "solos" en la primera hora.
//
// Este módulo agenda esos crons DENTRO del servidor Next (Railway está siempre
// encendido): cada tick hace un self-fetch HTTP al endpoint del cron con el
// CRON_SECRET, reutilizando intactos su auth, su candado de BD (withCronLock —
// seguro incluso ante disparos manuales/externos en paralelo) y su throttling
// de cuota SAT. Los endpoints son gap-driven: cuando no hay nada pendiente, un
// tick es un no-op barato, así que una cadencia agresiva no gasta cuota de más.
//
// Desde ago-2026 este scheduler es la ÚNICA fuente de disparo del pipeline:
// los workflows de Actions equivalentes se eliminaron (consumían el budget de
// Actions y duplicaban cada corrida). Los workflows que quedan en Actions son
// notificaciones/digests/auditorías sin equivalente en-proceso.
//
// Encendido: producción con CRON_SECRET definido (o IN_APP_CRON=1 para forzar
// en dev). Apagado: IN_APP_CRON=0. Singleton vía globalThis (sobrevive HMR).
// ─────────────────────────────────────────────────────────────────────────────

type Job = {
  /** Nombre lógico (ruta bajo /api/cron/). */
  name: string;
  /** Cadencia entre ticks. */
  everyMs: number;
  /** Espera antes del primer tick (escalona el arranque). */
  firstDelayMs: number;
  /** Query string opcional (sin `?`) — permite dos cadencias del MISMO cron
   *  con parámetros distintos, p. ej. vigencia del ejercicio en curso vs. del
   *  histórico. */
  query?: string;
};

const MIN = 60_000;
const HOUR = 60 * MIN;

// Cadencias: el backfill corre cada 10 min (vs. 1 h en Actions) para que una
// empresa nueva vea su historial entrar en la primera hora — el candado y la
// cuota por corrida (MAX_NEW_SUBMITS) mantienen el gasto SAT acotado.
const JOBS: Job[] = [
  { name: "sat-backfill", everyMs: 10 * MIN, firstDelayMs: 2 * MIN },
  { name: "sat-sync", everyMs: 4 * HOUR, firstDelayMs: 5 * MIN },
  // El workflow de Actions de sat-sync encadenaba cancel-sync como segundo
  // paso. Aquí va como job propio, desfasado ~30 min del sync para conservar
  // el orden "primero XMLs vigentes, luego cancelaciones" en cada ciclo.
  { name: "sat-cancel-sync", everyMs: 4 * HOUR, firstDelayMs: 35 * MIN },
  // Vigencia por UUID contra el servicio público del SAT: la RED DE SEGURIDAD
  // del cancel-sync de arriba, que sólo ve una ventana de meses y consume cuota
  // vitalicia (5002). Existía sin dispararse — una cancelación fuera de ventana
  // (emitida en enero, cancelada en marzo al refacturar) no se detectaba nunca.
  // Sin FIEL y sin cuota; el único costo es tiempo (una llamada por CFDI).
  //
  // Dos cadencias sobre el MISMO endpoint, con el mismo candado (una corrida a
  // la vez; el 409 ocasional sólo salta ese tick — nunca se golpea al SAT en
  // paralelo):
  //   · Ejercicio en curso, cada 2 h: es lo único que legalmente todavía puede
  //     cancelarse (CFF 2022: la cancelación vive hasta la anual del ejercicio).
  //   · Histórico desde 2015, cada 6 h: drena las NUNCA verificadas — el cursor
  //     ordena `vigenciaCheckedAt` nulls-first, así que al onboardear una
  //     empresa su historial recién importado entra primero y, una vez cubierto,
  //     el job se vuelve una rotación lenta e inofensiva.
  { name: "sat-vigencia-sync", everyMs: 2 * HOUR, firstDelayMs: 45 * MIN, query: "limit=400" },
  {
    name: "sat-vigencia-sync",
    everyMs: 6 * HOUR,
    firstDelayMs: 50 * MIN,
    query: "desde=2015-01-01&limit=500",
  },
  { name: "sat-rawxml-backfill", everyMs: 6 * HOUR, firstDelayMs: 15 * MIN },
  // Ídem: el workflow de rawxml-backfill encadenaba el desglose de impuestos
  // (parse local del rawXml recién bajado, sin cuota SAT).
  { name: "invoice-taxes-backfill", everyMs: 6 * HOUR, firstDelayMs: 25 * MIN },
  // Ídem, del mismo rawXml: nombre/RFC de la contraparte. Sin esto, los CFDIs a
  // público en general (que no llevan Customer a propósito) salían como "—" en
  // la lista aunque el nombre venga en el comprobante. Gap-driven: converge.
  { name: "invoice-contraparte-backfill", everyMs: 6 * HOUR, firstDelayMs: 40 * MIN },
  { name: "compliance-provision", everyMs: 24 * HOUR, firstDelayMs: 3 * MIN },
  { name: "compliance-sync", everyMs: 6 * HOUR, firstDelayMs: 8 * MIN },
  // Acuses MENSUALES desde Syntage (PDF + parse con Claude). Corría SÓLO en el
  // workflow de Actions del día 22 — con Actions caído, una empresa nueva se
  // quedaba sin sus mensuales para siempre y el checklist los pedía a mano.
  // Gap-driven con tope de 10 acuses por corrida: sin faltantes es un no-op.
  { name: "declaraciones-backfill", everyMs: 6 * HOUR, firstDelayMs: 20 * MIN },
  // Inventario automotriz: deriva unidades de los CFDIs recién bajados (parse
  // local del rawXml, sin cuota SAT). Desfasado del rawxml-backfill para
  // procesar lo que ese ciclo acaba de traer; sin empresas AUTOMOTRIZ es no-op.
  { name: "vehiculos-backfill", everyMs: 6 * HOUR, firstDelayMs: 30 * MIN },
  // Costo financiero del plan piso por unidad-mes (local, sin SAT). Diario:
  // sólo acumula meses vencidos, así que la mayoría de corridas son no-op.
  { name: "interes-piso", everyMs: 24 * HOUR, firstDelayMs: 40 * MIN },
  // Carga inicial del vertical automotriz: ambos drenan TODO el archivo con
  // cursor durable (BackfillProgreso) y, sin companyId, eligen solos a la
  // empresa que aún no termina — una agencia nueva queda cargada sin que nadie
  // encadene llamadas. Al terminar el barrido, cada tick es un no-op barato.
  { name: "refacciones-backfill", everyMs: 30 * MIN, firstDelayMs: 55 * MIN },
  { name: "servicio-backfill", everyMs: 30 * MIN, firstDelayMs: 60 * MIN },
  // Costo de nómina por línea de negocio: sin él, el taller reporta ingreso
  // sin costo y su margen es una ficción.
  { name: "nomina-costo-backfill", everyMs: 30 * MIN, firstDelayMs: 65 * MIN },
];

const FLAG = Symbol.for("contabilidad-os.cron-scheduler");

function baseUrl(): string {
  return `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

/** Un tick: self-fetch al endpoint del cron. 409 = otra corrida en curso (ok). */
async function tick(name: string, query?: string): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  try {
    const res = await fetch(`${baseUrl()}/api/cron/${name}${query ? `?${query}` : ""}`, {
      method: "POST",
      headers: { "x-cron-secret": secret },
    });
    if (!res.ok && res.status !== 409) {
      console.error(`[cron-scheduler] ${name}: HTTP ${res.status}`);
    }
  } catch (e) {
    console.error(`[cron-scheduler] ${name}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Empuje inmediato de un cron (fire-and-forget), p. ej. al crear una empresa
 * con e.firma: el onboarding no espera al siguiente tick para arrancar el
 * backfill. Pequeño delay para que la transacción/aprovisionamiento asiente.
 */
export function kickCron(name: string, delayMs = 5_000): void {
  if (!process.env.CRON_SECRET) return;
  const t = setTimeout(() => void tick(name), delayMs);
  if (typeof t.unref === "function") t.unref();
}

/** Arranca el scheduler (idempotente; una sola vez por proceso). */
export function startInAppCron(): void {
  const enabled =
    process.env.IN_APP_CRON === "1" ||
    (process.env.IN_APP_CRON !== "0" && process.env.NODE_ENV === "production");
  if (!enabled) return;
  if (!process.env.CRON_SECRET) {
    console.warn("[cron-scheduler] CRON_SECRET no definido — scheduler apagado.");
    return;
  }

  const g = globalThis as Record<symbol, boolean | undefined>;
  if (g[FLAG]) return;
  g[FLAG] = true;

  for (const job of JOBS) {
    const first = setTimeout(() => {
      void tick(job.name, job.query);
      const interval = setInterval(() => void tick(job.name, job.query), job.everyMs);
      if (typeof interval.unref === "function") interval.unref();
    }, job.firstDelayMs);
    if (typeof first.unref === "function") first.unref();
  }
  console.log(
    `[cron-scheduler] pipeline en-proceso activo: ${JOBS.map(
      (j) => `${j.name}${j.query ? `?${j.query}` : ""} c/${Math.round(j.everyMs / MIN)}min`
    ).join(", ")}`
  );
}
