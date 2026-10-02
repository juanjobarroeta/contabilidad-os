import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { expirarSolicitudesVencidas, submitSatSync, verifyAndImportSatSync, type SubmitSatSyncResult } from "@/lib/sat-sync";
import { coberturaSospechosa, mesesCompletos, satDijoSinSolapes, type CoberturaPeriodo } from "@/lib/sat-cobertura";
import { mesCerrado } from "@/lib/sat-sync-politica";
import { partirMes, etiquetaTramo } from "@/lib/sat-tramos";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/sat-backfill
//
// One-time HISTORICAL backfill of CFDIs, separate from the incremental
// /api/cron/sat-sync (which only covers the last few months). Walks each
// company's history back to `satBackfillYears` (clamped by
// fechaInicioOperaciones) and drives SAT requests through submit → verify →
// import across many runs.
//
// THROTTLED on purpose: SAT enforces a per-RFC quota (error 5002). So per run
// we cap how many NEW period-requests we submit, while still verifying/importing
// anything already pending (which costs no new quota). Run it on a schedule
// (e.g. hourly); it resumes where it left off and marks
// Company.satBackfillCompletedAt when every in-range period is imported.
//
// Auth: shared secret in CRON_SECRET (Bearer or x-cron-secret), same as the
// incremental cron.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Quota pacing. SAT throttles simultaneous requests per RFC; keep NEW submits
// small. Verifying already-submitted periods is free, so we allow more of those.
const MAX_NEW_SUBMITS_PER_COMPANY = 8;
const MAX_PERIODS_TOUCHED_PER_COMPANY = 30;
const MAX_COMPANIES_PER_RUN = 25;
// Meses con la cuota del mes completo quemada que se rellenan EN TRAMOS por
// empresa y corrida: cada uno son 4 solicitudes (2 tramos × 2 lados).
const MAX_MESES_EN_TRAMOS_POR_CORRIDA = 1;
const TRAMOS_POR_MES = 2;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

/** Periods (year, month) from the current month back `years`, newest first. */
function backfillPeriods(years: number): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  const now = new Date();
  const total = years * 12; // include the current month + (years*12 - 1) before
  for (let i = 0; i < total; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  return out;
}

/**
 * Meses «year-month» pedidos COMPLETOS: la unión de los rangos FINISHED de cada
 * lado cubre el mes entero. Antes bastaba una fila FINISHED por lado, sin mirar
 * el rango: un tramo o un «del 1 a ayer» daban el mes por hecho.
 */
async function finishedPeriods(companyId: string): Promise<Set<string>> {
  const rows = await prisma.satSyncRequest.findMany({
    where: { companyId, tipo: { in: ["EMITIDOS", "RECIBIDOS"] } },
    select: { year: true, month: true, tipo: true, status: true, desde: true, hasta: true },
  });
  return mesesCompletos(rows);
}

/**
 * El mes completo tiene la cuota quemada (5002) en algún lado: se pide en
 * tramos, que son otra llave de cuota. Las solicitudes de tramo quedan
 * guardadas con su rango, así que la siguiente corrida las reutiliza y
 * verifica sin gastar nada; si un tramo también está quemado, la decisión de
 * sat-reintentos lo salta sin tocar al SAT.
 */
async function rellenarEnTramos(companyId: string, year: number, month: number): Promise<{ submits: number; importadas: number; tramos: string[] }> {
  let submits = 0, importadas = 0;
  const tramos: string[] = [];
  for (const t of partirMes(year, month, TRAMOS_POR_MES)) {
    const sub = await submitSatSync(companyId, year, month, false, t);
    if (!sub.ok) { tramos.push(`${etiquetaTramo(t)}: ${sub.status === 429 ? "en espera" : sub.error.slice(0, 60)}`); continue; }
    if (!sub.reusedEmitidos && sub.emitidosRequestId) submits++;
    if (!sub.reusedRecibidos && sub.recibidosRequestId) submits++;
    const ver = await verifyAndImportSatSync(companyId, sub.emitidosRequestId, sub.recibidosRequestId);
    const imp = ver.ok && typeof ver.imported === "number" ? ver.imported : 0;
    importadas += imp;
    tramos.push(`${etiquetaTramo(t)}: ${ver.ok ? `${ver.status} +${imp}` : ver.error.slice(0, 60)}`);
  }
  return { submits, importadas, tramos };
}

/** ¿El mes completo quedó sin poder pedirse (cuota o intentos agotados) en algún lado? */
function mesQuemado(r: SubmitSatSyncResult): boolean {
  const b = r.bloqueos ?? [];
  if (b.some((x) => x.motivo === "cuota_agotada" || x.motivo === "intentos_agotados")) return true;
  return !r.ok && r.error.includes("5002");
}

/**
 * Lo que el SAT dijo tener contra lo que tenemos, por periodo.
 *
 * Dos consultas agrupadas por empresa —NO una por mes—: con 30 periodos y 25
 * empresas por corrida, una consulta por mes serían 750 idas a la base.
 */
async function coberturaDe(
  companyId: string,
  periodos: Array<{ year: number; month: number }>,
): Promise<CoberturaPeriodo[]> {
  const [solicitudes, facturas] = await Promise.all([
    // Una fila por RANGO distinto: sumar todas las FINISHED cuenta el mes
    // tantas veces como se haya pedido (submitSatSync crea fila nueva pasada la
    // ventana de 24h). Con tramos hay varias filas legítimas, una por rango
    // disjunto, y ésas sí suman. Ver sat-cobertura para la medición que lo cazó.
    // Rangos enciman (sat-sync pide «del 1 a ayer» cada día): la unión, no la
    // suma. Ver satDijoSinSolapes.
    prisma.satSyncRequest.findMany({
      where: { companyId, status: "FINISHED" },
      select: { year: true, month: true, tipo: true, status: true, desde: true, hasta: true, cfdisFound: true, createdAt: true },
    }),
    prisma.$queryRaw<Array<{ year: number; month: number; n: bigint }>>`
      SELECT EXTRACT(YEAR FROM "fecha")::int AS year,
             EXTRACT(MONTH FROM "fecha")::int AS month,
             COUNT(*) AS n
      FROM "Invoice"
      WHERE "companyId" = ${companyId}
      GROUP BY 1, 2
    `,
  ]);

  const satPor = satDijoSinSolapes(solicitudes);
  const nuestrasPor = new Map(facturas.map((r) => [`${r.year}-${r.month}`, Number(r.n)]));

  return periodos.map(({ year, month }) => ({
    year,
    month,
    satDijo: satPor.get(`${year}-${month}`) ?? 0,
    tenemos: nuestrasPor.get(`${year}-${month}`) ?? 0,
  }));
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

    const startedAt = Date.now();
  // Lo que lleva más de 72 h en vuelo ya no existe en el SAT: fuera de la cola.
  const expiradas = await expirarSolicitudesVencidas();
  // Gap-driven selection: every FIEL company with a backfill order, NOT just the
  // ones still flagged incomplete. We recompute the real outstanding gap below and
  // trust that over the completed flag — so raising satBackfillYears (or any lost
  // period) self-heals. nulls-first keeps not-yet-complete companies at the front
  // so they always get worked before we spend the run gap-checking finished ones.
  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
      autoSyncEnabled: true,
      satBackfillYears: { gt: 0 },
      fielCer: { not: null },
      fielKey: { not: null },
      fielPassword: { not: null },
    },
    select: {
      id: true,
      rfc: true,
      fechaInicioOperaciones: true,
      satBackfillYears: true,
      satBackfillCompletedAt: true,
    },
    orderBy: { satBackfillCompletedAt: { sort: "asc", nulls: "first" } },
    take: MAX_COMPANIES_PER_RUN,
  });

  let totalSubmitted = 0;
  let totalImported = 0;
  let companiesCompleted = 0;
  const perCompany: Array<{
    rfc: string; touched: number; remaining: number; done: boolean; coberturaDudosa?: number;
    /** Meses del mes completo con cuota quemada en esta corrida (se rellenan en tramos). */
    quemados?: number;
    /** Meses que no se pidieron por un fallo reciente del SAT (se reintentan solos). */
    enEspera?: number;
    tramos?: Array<{ periodo: string; importadas: number; detalle: string[] }>;
  }> = [];
  let totalEnTramos = 0;
  // Meses marcados «hechos» que no cuadran con lo que el SAT dijo tener.
  const coberturaDudosa: Array<{
    rfc: string;
    periodos: Array<{ periodo: string; satDijo: number; tenemos: number; faltanCuandoMenos: number }>;
  }> = [];
  const errors: Array<{ companyId: string; rfc: string; error: string }> = [];

  for (const company of companies) {
    try {
      // Sólo meses CERRADOS: el mes en curso es de sat-sync («del 1 a ayer»,
      // rango nuevo cada día) y nunca puede quedar «completo» por rango.
      const allPeriods = backfillPeriods(company.satBackfillYears).filter((p) => {
        if (!mesCerrado(p.year, p.month, new Date())) return false;
        if (!company.fechaInicioOperaciones) return true;
        const monthEnd = new Date(p.year, p.month, 0, 23, 59, 59);
        return monthEnd >= company.fechaInicioOperaciones;
      });

      const done = await finishedPeriods(company.id);

      // ¿Los meses «hechos» realmente trajeron facturas? Se evalúa ANTES de
      // cualquier salida temprana: la empresa que importa es justo la que ya
      // está marcada completa —MARGOM lo estaba, con ocho meses vacíos—, y si
      // esto viviera después del `continue` de «no queda nada» nunca correría
      // donde hace falta.
      //
      // REPORTA, no desmarca: un mes con la cuota 5002 quemada no se puede
      // rellenar por esta vía, y reintentarlo en automático se comería el
      // presupuesto de solicitudes de cada corrida sin traer nada. Rellenarlo es
      // un acto deliberado con sat-repesca (que pide el mes en tramos).
      const sospechas = coberturaSospechosa(await coberturaDe(company.id, allPeriods));
      if (sospechas.length > 0) {
        coberturaDudosa.push({
          rfc: company.rfc,
          periodos: sospechas.map((s) => ({
            periodo: s.periodo,
            satDijo: s.satDijo,
            tenemos: s.tenemos,
            faltanCuandoMenos: s.faltanCuandoMenos,
          })),
        });
      }
      const dudosas = sospechas.length || undefined;

      // Read the REAL outstanding gap and let it drive everything, overriding a
      // stale completed flag in either direction.
      const remainingBefore = allPeriods.filter((p) => !done.has(`${p.year}-${p.month}`)).length;
      if (remainingBefore === 0) {
        // Fully imported in range — make sure the flag reflects that and move on
        // without spending any SAT quota.
        if (!company.satBackfillCompletedAt) {
          await prisma.company.update({
            where: { id: company.id },
            data: { satBackfillCompletedAt: new Date() },
          });
          companiesCompleted++;
        }
        perCompany.push({
          rfc: company.rfc, touched: 0, remaining: 0, done: true, coberturaDudosa: dudosas,
        });
        continue;
      }
      // There is a gap. If the company was flagged complete (e.g. satBackfillYears
      // was raised after it "finished"), reopen it so status/selection reflect the
      // real outstanding work and the order keeps running until truly done.
      if (company.satBackfillCompletedAt) {
        await prisma.company.update({
          where: { id: company.id },
          data: { satBackfillCompletedAt: null },
        });
      }

      let newSubmits = 0;
      let touched = 0;
      let quemados = 0;
      let enEspera = 0;
      let mesesEnTramos = 0;
      const tramosHechos: Array<{ periodo: string; importadas: number; detalle: string[] }> = [];

      for (const { year, month } of allPeriods) {
        if (done.has(`${year}-${month}`)) continue; // already imported
        if (touched >= MAX_PERIODS_TOUCHED_PER_COMPANY) break;

        // submitSatSync reuses recent requests (no new quota); it only costs
        // quota when it creates fresh ones. Defer brand-new periods once we hit
        // the per-run new-submit cap so we don't trip SAT's 5002.
        const submitted = await submitSatSync(company.id, year, month);
        if (mesQuemado(submitted)) {
          // Antes: `break` — un mes quemado paraba la carga de TODOS los meses
          // anteriores de la empresa, para siempre. Ahora el mes se rellena en
          // tramos (otra llave de cuota) y se sigue con los demás.
          quemados++;
          if (mesesEnTramos < MAX_MESES_EN_TRAMOS_POR_CORRIDA) {
            mesesEnTramos++;
            const r = await rellenarEnTramos(company.id, year, month);
            totalSubmitted += r.submits;
            totalImported += r.importadas;
            if (r.submits > 0) newSubmits++;
            tramosHechos.push({ periodo: `${year}-${String(month).padStart(2, "0")}`, importadas: r.importadas, detalle: r.tramos });
            totalEnTramos++;
          }
          if (!submitted.ok) continue;
        }
        if (!submitted.ok) {
          if (submitted.status === 400) continue; // period not complete yet — benign
          if (submitted.status === 429) { enEspera++; continue; } // fallo reciente del SAT: se reintenta solo
          errors.push({ companyId: company.id, rfc: company.rfc, error: submitted.error });
          continue;
        }
        touched++;
        const createdNew =
          (!submitted.reusedEmitidos && !!submitted.emitidosRequestId) ||
          (!submitted.reusedRecibidos && !!submitted.recibidosRequestId);
        if (createdNew) {
          if (!submitted.reusedEmitidos && submitted.emitidosRequestId) totalSubmitted++;
          if (!submitted.reusedRecibidos && submitted.recibidosRequestId) totalSubmitted++;
          newSubmits++;
        }

        const verified = await verifyAndImportSatSync(
          company.id,
          submitted.emitidosRequestId,
          submitted.recibidosRequestId
        );
        if (verified.ok && typeof verified.imported === "number") {
          totalImported += verified.imported;
        }

        if (newSubmits >= MAX_NEW_SUBMITS_PER_COMPANY) break; // pace new requests
      }

      // Recompute completion after this run's imports.
      const doneNow = await finishedPeriods(company.id);
      const remaining = allPeriods.filter((p) => !doneNow.has(`${p.year}-${p.month}`)).length;
      const isDone = remaining === 0;
      if (isDone) {
        await prisma.company.update({
          where: { id: company.id },
          data: { satBackfillCompletedAt: new Date() },
        });
        companiesCompleted++;
      }
      perCompany.push({
        rfc: company.rfc,
        touched,
        remaining,
        done: isDone,
        coberturaDudosa: dudosas,
        quemados: quemados || undefined,
        enEspera: enEspera || undefined,
        tramos: tramosHechos.length ? tramosHechos : undefined,
      });
    } catch (e) {
      console.error(`[cron/sat-backfill] company ${company.id} failed:`, e);
      errors.push({
        companyId: company.id,
        rfc: company.rfc,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const summary = {
    ok: true,
    companiesEligible: companies.length,
    companiesCompleted,
    submitted: totalSubmitted,
    imported: totalImported,
    expiradas,
    mesesEnTramos: totalEnTramos,
    perCompany,
    coberturaDudosa,
    errors,
    elapsedMs: Date.now() - startedAt,
    nota:
      coberturaDudosa.length > 0
        ? "Hay meses marcados «hechos» con muchas menos facturas de las que el SAT dijo tener. " +
          "NO se re-piden en automático (la cuota 5002 es vitalicia y se gastaría en vano): " +
          "rellénalos con sat-repesca, que pide el mes en tramos."
        : undefined,
  };
  console.log("[cron/sat-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:sat-backfill", () => handle(req));
}

export async function GET(req: Request) {
  return withCronLock("cron:sat-backfill", () => handle(req));
}
