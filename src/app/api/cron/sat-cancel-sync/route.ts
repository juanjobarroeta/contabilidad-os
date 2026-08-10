import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { syncCancelacionesPeriodo } from "@/lib/sat-sync";
import { mesesVentanaCancelable } from "@/lib/sat-cancelaciones";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/sat-cancel-sync
//
// Detecta CFDIs cancelados en el SAT (descarga de metadata) y revierte su
// efecto marcándolos CANCELLED — el motor fiscal deja de contarlos. Dos fases:
//
// FASE A — Ventana legal rodante. Para cada empresa con FIEL, re-consulta los
// meses de emisión que TODAVÍA son legalmente cancelables (CFF Art. 29-A desde
// 2022: hasta la anual del ejercicio de emisión). La ventana es dinámica —
// 5..16 meses según la fecha — porque la fija de 3 meses tenía un hueco real:
// una factura de enero cancelada en noviembre jamás se detectaba.
//
// FASE B — Backfill histórico ÚNICO. El backfill de XML importa TODO lo que el
// SAT entrega como STAMPED, y los paquetes XML incluyen CFDIs ya cancelados
// (el XML no trae estatus): una empresa recién onboardeada puede cargar años
// de facturas canceladas contadas como vigentes. Esta fase recorre una sola
// vez la misma ventana del backfill (satBackfillYears) con consultas de
// metadata y aplica las cancelaciones históricas. El progreso es durable en
// SatSyncRequest (mes hecho ⇔ METADATA_EMITIDOS y METADATA_RECIBIDOS en
// FINISHED, igual que el backfill de XML): re-correr no re-consulta lo hecho,
// y los años cerrados no pueden recibir cancelaciones nuevas, así que "hecho"
// es hecho para siempre. Sólo corre cuando el backfill de XML de la empresa ya
// terminó (antes, faltarían facturas que marcar y el mes quedaría "hecho" en
// falso).
//
// Cuotas: cada mes son 2 solicitudes de metadata al SAT (emitidos/recibidos),
// con reúso de 24h. La fase B va acotada por corrida (pocos meses por empresa)
// para respetar el límite por RFC del SAT — mismo espíritu que sat-backfill.
//
// Misma cadencia submit→verify que el sync de XML: SAT es asíncrono, así que
// un periodo puede quedar "pending" y resolverse en una corrida posterior.
// Seguro de re-ejecutar (idempotente: sólo STAMPED→CANCELLED).
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Fase B: meses históricos tocados por empresa por corrida (2 requests c/u). */
const MAX_HIST_PERIODS_PER_COMPANY = 6;
/** Presupuesto de tiempo: dejar margen bajo maxDuration para responder. */
const TIME_BUDGET_MS = 240_000;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

/** Periodos (year, month) desde el mes actual hacia atrás, el más nuevo primero. */
function periodosHaciaAtras(desde: Date, cuantos: number): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  for (let i = 0; i < cuantos; i++) {
    const d = new Date(desde.getFullYear(), desde.getMonth() - i, 1);
    out.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  return out;
}

/** Meses con AMBAS consultas de metadata FINISHED (progreso durable, cualquier edad). */
async function mesesMetadataHechos(companyId: string): Promise<Set<string>> {
  const rows = await prisma.satSyncRequest.findMany({
    where: {
      companyId,
      tipo: { in: ["METADATA_EMITIDOS", "METADATA_RECIBIDOS"] },
      status: "FINISHED",
    },
    select: { year: true, month: true, tipo: true },
  });
  const porMes = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = `${r.year}-${r.month}`;
    if (!porMes.has(key)) porMes.set(key, new Set());
    porMes.get(key)!.add(r.tipo);
  }
  const hechos = new Set<string>();
  for (const [key, tipos] of porMes) {
    if (tipos.has("METADATA_EMITIDOS") && tipos.has("METADATA_RECIBIDOS")) hechos.add(key);
  }
  return hechos;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const monthsParam = parseInt(url.searchParams.get("months") ?? "", 10);
  // Default: la ventana LEGAL de cancelación (dinámica, 5..16 meses). El tope
  // manual sube a 60 para pasadas profundas dirigidas (?companyId=&months=60).
  const monthsBack = Number.isFinite(monthsParam)
    ? Math.min(Math.max(monthsParam, 1), 60)
    : mesesVentanaCancelable(new Date());
  const onlyCompanyId = url.searchParams.get("companyId");
  // dryRun: descarga y reporta qué cancelaría, SIN escribir — para validar el
  // formato del metadata contra una cancelación conocida antes de confiar.
  const dryRun = ["1", "true", "yes"].includes((url.searchParams.get("dryRun") ?? "").toLowerCase());
  const startedAt = Date.now();

  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
      fielCer: { not: null },
      fielKey: { not: null },
      fielPassword: { not: null },
      ...(onlyCompanyId ? { id: onlyCompanyId } : {}),
    },
    select: {
      id: true,
      rfc: true,
      satBackfillYears: true,
      satBackfillCompletedAt: true,
      fechaInicioOperaciones: true,
    },
  });

  const now = new Date();
  const periods = periodosHaciaAtras(now, monthsBack);

  let companiesProcessed = 0;
  let totalCancelled = 0;
  let totalWouldCancel = 0;
  const errors: Array<{ companyId: string; rfc: string; error: string }> = [];

  // ── FASE A: ventana legal rodante ──────────────────────────────────────────
  for (const company of companies) {
    try {
      for (const { year, month } of periods) {
        const res = await syncCancelacionesPeriodo(company.id, year, month, dryRun);
        if (res.ok && res.cancelled) totalCancelled += res.cancelled;
        if (res.ok && res.wouldCancel) totalWouldCancel += res.wouldCancel.length;
        if (!res.ok && res.error) {
          errors.push({ companyId: company.id, rfc: company.rfc, error: res.error });
        }
      }
      companiesProcessed++;
    } catch (e) {
      errors.push({ companyId: company.id, rfc: company.rfc, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── FASE B: backfill histórico único (gap-driven, acotado por corrida) ─────
  // En dryRun se OMITE: syncCancelacionesPeriodo marca FINISHED las solicitudes
  // aunque no escriba cancelaciones, y eso daría meses "hechos" sin aplicar.
  let histPeriodos = 0;
  let histCancelled = 0;
  let histPendientes = 0;
  let histCompaniesTouched = 0;
  if (!dryRun) {
    for (const company of companies) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;
      // Sólo cuando el backfill de XML terminó: si faltan facturas por importar,
      // un mes "hecho" ahora dejaría canceladas sin marcar para siempre.
      if (!company.satBackfillCompletedAt || !company.satBackfillYears) continue;

      const inicioOps = company.fechaInicioOperaciones;
      const hechos = await mesesMetadataHechos(company.id);
      // La misma ventana del backfill de XML, saltando lo que la fase A ya
      // cubre (los meses de la ventana legal) y lo previo al inicio de
      // operaciones. Más nuevo primero: ahí es más probable que haya
      // cancelaciones aplicables.
      const historicos = periodosHaciaAtras(now, company.satBackfillYears * 12)
        .slice(monthsBack)
        .filter((p) => !hechos.has(`${p.year}-${p.month}`))
        .filter((p) => {
          if (!inicioOps) return true;
          const ini = { year: inicioOps.getFullYear(), month: inicioOps.getMonth() + 1 };
          return p.year > ini.year || (p.year === ini.year && p.month >= ini.month);
        })
        .slice(0, MAX_HIST_PERIODS_PER_COMPANY);
      if (historicos.length === 0) continue;

      histCompaniesTouched++;
      for (const { year, month } of historicos) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) break;
        try {
          const res = await syncCancelacionesPeriodo(company.id, year, month, false);
          histPeriodos++;
          if (res.ok && res.cancelled) histCancelled += res.cancelled;
          if (res.ok && res.status === "pending") histPendientes++;
          if (!res.ok && res.error) {
            errors.push({ companyId: company.id, rfc: company.rfc, error: res.error });
          }
        } catch (e) {
          errors.push({ companyId: company.id, rfc: company.rfc, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
  }

  const summary = {
    ok: true,
    dryRun,
    monthsBack,
    companies: companies.length,
    companiesProcessed,
    ...(dryRun ? { wouldCancelDetected: totalWouldCancel } : { cancelledDetected: totalCancelled }),
    historico: dryRun
      ? { skipped: true }
      : {
          companiesTouched: histCompaniesTouched,
          periodos: histPeriodos,
          cancelled: histCancelled,
          pendientes: histPendientes,
        },
    errors,
    elapsedMs: Date.now() - startedAt,
  };
  console.log("[cron/sat-cancel-sync] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:sat-cancel-sync", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:sat-cancel-sync", () => handle(req));
}
