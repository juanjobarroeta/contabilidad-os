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
//
// RITMO ADAPTATIVO (ago-2026). Las cadencias dejaron de ser intervalos fijos:
// tras cada corrida, el trabajo decide cuándo volver según lo que reportó —
// si le quedó pendiente vuelve en segundos, si quedó ocioso regresa a su
// cadencia de reposo. Motivo: un rezago de 212 mil facturas tardaba 26 días en
// drenar a 2 mil cada 6 h, no por caro (200 filas/segundo, puramente local)
// sino porque nadie lo volvía a llamar. La palanca de seguridad es el PISO por
// trabajo (`minMs`): los que hablan con el SAT o cuestan dinero conservan uno
// alto, así acelerar el drenado local nunca atropella una cuota externa.
// Ver src/lib/cron/ritmo.ts para la decisión (pura y testeada).
// ─────────────────────────────────────────────────────────────────────────────

import { siguienteEspera, hizoTrabajo, type SeñalCorrida } from "@/lib/cron/ritmo";

type Job = {
  /** Nombre lógico (ruta bajo /api/cron/). */
  name: string;
  /** Cadencia de REPOSO: cada cuánto se revisa cuando no hay nada que hacer. */
  everyMs: number;
  /** Espera antes del primer tick (escalona el arranque). */
  firstDelayMs: number;
  /** Query string opcional (sin `?`) — permite dos cadencias del MISMO cron
   *  con parámetros distintos, p. ej. vigencia del ejercicio en curso vs. del
   *  histórico. */
  query?: string;
  /**
   * PISO entre corridas. Es la palanca de seguridad del ritmo adaptativo: un
   * trabajo que habla con el SAT lo lleva alto para no atropellar sus cuotas
   * ni sus límites; uno local (parsear XML ya guardado) puede ir seguido.
   * Default: MIN_LOCAL.
   */
  minMs?: number;
  /**
   * Trabajos a empujar cuando ÉSTE movió algo. Encadena el pipeline por
   * evento en vez de por desfase de reloj: el XML que acaba de bajar dispara
   * su derivación en segundos, no en la próxima cita de 6 horas.
   */
  encadena?: string[];
};

const MIN = 60_000;
const HOUR = 60 * MIN;

// Pisos del ritmo adaptativo. Un trabajo con pendientes se vuelve a llamar en
// segundos (ver lib/cron/ritmo.ts), así que el piso es lo que impide que esa
// aceleración toque al SAT más seguido de lo debido.
/** Local (parsear XML guardado, derivar en BD): puede ir seguido. */
const MIN_LOCAL = 10_000;
/** Habla con el SAT / consume cuota o límites externos. */
const MIN_SAT = 5 * MIN;
/** Cuesta dinero por corrida (LLM, extracciones de terceros). */
const MIN_CARO = 15 * MIN;

// Cadencias: el backfill corre cada 10 min (vs. 1 h en Actions) para que una
// empresa nueva vea su historial entrar en la primera hora — el candado y la
// cuota por corrida (MAX_NEW_SUBMITS) mantienen el gasto SAT acotado.
const JOBS: Job[] = [
  { name: "sat-backfill", everyMs: 10 * MIN, firstDelayMs: 2 * MIN, minMs: MIN_SAT,
    // Lo que el SAT acaba de entregar se deriva enseguida, sin esperar cita.
    encadena: ["sat-rawxml-backfill", "onboarding-drive"] },
  // ORQUESTADOR de la carga inicial. El pipeline de una empresa nueva es una
  // cadena (XML → impuestos → contraparte → vigencia) y cada eslabón vive en un
  // cron que corre cada 6 h repartiendo su cupo entre TODO el portafolio: una
  // empresa recién onboardeada tardaba días en quedar al corriente y alguien
  // terminaba empujando los crons a mano, cliente por cliente. Éste encuentra a
  // las más atrasadas y les empuja su siguiente eslabón, por empresa. Cadencia
  // agresiva porque cuando nadie está cargando es un no-op de una consulta.
  { name: "onboarding-drive", everyMs: 10 * MIN, firstDelayMs: 4 * MIN, minMs: MIN_LOCAL },
  { name: "sat-sync", everyMs: 4 * HOUR, firstDelayMs: 5 * MIN, minMs: MIN_SAT,
    encadena: ["sat-rawxml-backfill"] },
  // El workflow de Actions de sat-sync encadenaba cancel-sync como segundo
  // paso. Aquí va como job propio, desfasado ~30 min del sync para conservar
  // el orden "primero XMLs vigentes, luego cancelaciones" en cada ciclo.
  { name: "sat-cancel-sync", everyMs: 4 * HOUR, firstDelayMs: 35 * MIN, minMs: MIN_SAT },
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
  { name: "sat-vigencia-sync", everyMs: 2 * HOUR, firstDelayMs: 45 * MIN, query: "limit=400", minMs: MIN_SAT },
  {
    name: "sat-vigencia-sync",
    everyMs: 6 * HOUR,
    firstDelayMs: 50 * MIN,
    query: "desde=2015-01-01&limit=500",
    minMs: MIN_SAT,
  },
  { name: "sat-rawxml-backfill", everyMs: 6 * HOUR, firstDelayMs: 15 * MIN, minMs: MIN_SAT,
    // El XML recién bajado alimenta impuestos, contraparte y la identidad
    // fiscal del cliente: se derivan ya.
    encadena: ["invoice-taxes-backfill", "invoice-contraparte-backfill", "cliente-fiscal-backfill"] },
  // Ídem: el workflow de rawxml-backfill encadenaba el desglose de impuestos
  // (parse local del rawXml recién bajado, sin cuota SAT).
  { name: "invoice-taxes-backfill", everyMs: 6 * HOUR, firstDelayMs: 25 * MIN, minMs: MIN_LOCAL },
  // Ídem, del mismo rawXml: nombre/RFC de la contraparte. Sin esto, los CFDIs a
  // público en general (que no llevan Customer a propósito) salían como "—" en
  // la lista aunque el nombre venga en el comprobante. Gap-driven: converge.
  { name: "invoice-contraparte-backfill", everyMs: 6 * HOUR, firstDelayMs: 40 * MIN, minMs: MIN_LOCAL },
  // Del MISMO rawXml: CP y régimen del cliente, que los importadores dejaban en
  // "616" y sin CP. Sin esto, facturarle a un cliente importado exigía capturar
  // sus datos fiscales a mano. Gap-driven: converge y se apaga solo.
  { name: "cliente-fiscal-backfill", everyMs: 6 * HOUR, firstDelayMs: 45 * MIN, minMs: MIN_LOCAL },
  { name: "compliance-provision", everyMs: 24 * HOUR, firstDelayMs: 3 * MIN, minMs: MIN_CARO },
  { name: "compliance-sync", everyMs: 6 * HOUR, firstDelayMs: 8 * MIN, minMs: MIN_CARO },
  // Acuses MENSUALES desde Syntage (PDF + parse con Claude). Corría SÓLO en el
  // workflow de Actions del día 22 — con Actions caído, una empresa nueva se
  // quedaba sin sus mensuales para siempre y el checklist los pedía a mano.
  // Gap-driven con tope de 10 acuses por corrida: sin faltantes es un no-op.
  { name: "declaraciones-backfill", everyMs: 6 * HOUR, firstDelayMs: 20 * MIN, minMs: MIN_CARO },
  // Inventario automotriz: deriva unidades de los CFDIs recién bajados (parse
  // local del rawXml, sin cuota SAT). Desfasado del rawxml-backfill para
  // procesar lo que ese ciclo acaba de traer; sin empresas AUTOMOTRIZ es no-op.
  { name: "vehiculos-backfill", everyMs: 6 * HOUR, firstDelayMs: 30 * MIN, minMs: MIN_LOCAL },
  // Costo financiero del plan piso por unidad-mes (local, sin SAT). Diario:
  // sólo acumula meses vencidos, así que la mayoría de corridas son no-op.
  { name: "interes-piso", everyMs: 24 * HOUR, firstDelayMs: 40 * MIN, minMs: MIN_LOCAL },
  // Carga inicial del vertical automotriz: ambos drenan TODO el archivo con
  // cursor durable (BackfillProgreso) y, sin companyId, eligen solos a la
  // empresa que aún no termina — una agencia nueva queda cargada sin que nadie
  // encadene llamadas. Al terminar el barrido, cada tick es un no-op barato.
  { name: "refacciones-backfill", everyMs: 30 * MIN, firstDelayMs: 55 * MIN, minMs: MIN_LOCAL },
  { name: "servicio-backfill", everyMs: 30 * MIN, firstDelayMs: 60 * MIN, minMs: MIN_LOCAL },
  // Costo de nómina por línea de negocio: sin él, el taller reporta ingreso
  // sin costo y su margen es una ficción.
  { name: "nomina-costo-backfill", everyMs: 30 * MIN, firstDelayMs: 65 * MIN, minMs: MIN_LOCAL },
];

const FLAG = Symbol.for("contabilidad-os.cron-scheduler");

function baseUrl(): string {
  return `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

/** Un tick: self-fetch al endpoint del cron. Devuelve la señal (status +
 *  cuerpo) para que el ritmo adaptativo decida cuándo volver a llamarlo.
 *  409 = otra corrida tiene el candado (no es error). */
async function tick(name: string, query?: string): Promise<SeñalCorrida> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { status: 0 };
  try {
    const res = await fetch(`${baseUrl()}/api/cron/${name}${query ? `?${query}` : ""}`, {
      method: "POST",
      headers: { "x-cron-secret": secret },
    });
    if (!res.ok && res.status !== 409) {
      console.error(`[cron-scheduler] ${name}: HTTP ${res.status}`);
    }
    const cuerpo = await res.json().catch(() => null);
    return { status: res.status, cuerpo };
  } catch (e) {
    console.error(`[cron-scheduler] ${name}:`, e instanceof Error ? e.message : e);
    return { status: 0 };
  }
}

/** Espera con `unref` para no retener el proceso vivo por un timer pendiente. */
function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
}

/**
 * Bucle de un trabajo: corre, decide cuándo volver según lo que reportó, y se
 * reprograma. Sustituye al setInterval fijo — ver la nota de RITMO ADAPTATIVO
 * arriba. Si el trabajo movió algo, empuja sus encadenados (una vez, sin
 * esperar su cita).
 */
async function correrEnBucle(job: Job): Promise<void> {
  await dormir(job.firstDelayMs);
  const etiqueta = `${job.name}${job.query ? `?${job.query}` : ""}`;
  for (;;) {
    const señal = await tick(job.name, job.query);
    if (job.encadena && hizoTrabajo(señal.cuerpo)) {
      for (const siguiente of job.encadena) kickCron(siguiente, 2_000);
    }
    const espera = siguienteEspera(señal, {
      baseMs: job.everyMs,
      minMs: job.minMs ?? MIN_LOCAL,
    });
    if (espera < job.everyMs) {
      console.log(`[cron-scheduler] ${etiqueta}: quedó trabajo, vuelve en ${Math.round(espera / 1000)}s`);
    }
    await dormir(espera);
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

  // Cada trabajo corre su propio bucle auto-reprogramado (setTimeout en cadena,
  // no setInterval): así la siguiente espera puede depender del resultado de la
  // corrida anterior. Un trabajo nunca se solapa consigo mismo porque sólo se
  // reprograma DESPUÉS de terminar — y el candado de BD cubre el resto.
  for (const job of JOBS) {
    void correrEnBucle(job);
  }
  console.log(
    `[cron-scheduler] pipeline en-proceso activo (ritmo adaptativo, reposo→piso): ${JOBS.map(
      (j) =>
        `${j.name}${j.query ? `?${j.query}` : ""} ${Math.round(j.everyMs / MIN)}min→${Math.round((j.minMs ?? MIN_LOCAL) / 1000)}s`
    ).join(", ")}`
  );
}
