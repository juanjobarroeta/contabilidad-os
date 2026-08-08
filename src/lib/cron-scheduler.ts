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
// seguro aunque Actions reviva y dispare en paralelo) y su throttling de cuota
// SAT. Los endpoints son gap-driven: cuando no hay nada pendiente, un tick es
// un no-op barato, así que una cadencia agresiva no gasta cuota de más.
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
};

const MIN = 60_000;
const HOUR = 60 * MIN;

// Cadencias: el backfill corre cada 10 min (vs. 1 h en Actions) para que una
// empresa nueva vea su historial entrar en la primera hora — el candado y la
// cuota por corrida (MAX_NEW_SUBMITS) mantienen el gasto SAT acotado.
const JOBS: Job[] = [
  { name: "sat-backfill", everyMs: 10 * MIN, firstDelayMs: 2 * MIN },
  { name: "sat-sync", everyMs: 4 * HOUR, firstDelayMs: 5 * MIN },
  { name: "sat-rawxml-backfill", everyMs: 6 * HOUR, firstDelayMs: 15 * MIN },
  { name: "compliance-provision", everyMs: 24 * HOUR, firstDelayMs: 3 * MIN },
  { name: "compliance-sync", everyMs: 6 * HOUR, firstDelayMs: 8 * MIN },
  // Acuses MENSUALES desde Syntage (PDF + parse con Claude). Corría SÓLO en el
  // workflow de Actions del día 22 — con Actions caído, una empresa nueva se
  // quedaba sin sus mensuales para siempre y el checklist los pedía a mano.
  // Gap-driven con tope de 10 acuses por corrida: sin faltantes es un no-op.
  { name: "declaraciones-backfill", everyMs: 6 * HOUR, firstDelayMs: 20 * MIN },
];

const FLAG = Symbol.for("contabilidad-os.cron-scheduler");

function baseUrl(): string {
  return `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

/** Un tick: self-fetch al endpoint del cron. 409 = otra corrida en curso (ok). */
async function tick(name: string): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  try {
    const res = await fetch(`${baseUrl()}/api/cron/${name}`, {
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
      void tick(job.name);
      const interval = setInterval(() => void tick(job.name), job.everyMs);
      if (typeof interval.unref === "function") interval.unref();
    }, job.firstDelayMs);
    if (typeof first.unref === "function") first.unref();
  }
  console.log(
    `[cron-scheduler] pipeline en-proceso activo: ${JOBS.map((j) => `${j.name} c/${Math.round(j.everyMs / MIN)}min`).join(", ")}`
  );
}
