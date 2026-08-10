import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { syncCancelacionesPeriodo } from "@/lib/sat-sync";
import { mesesVentanaCancelable } from "@/lib/sat-cancelaciones";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/sat-cancel-sync
//
// Detecta CFDIs cancelados en el SAT (descarga de metadata) y revierte su
// efecto marcándolos CANCELLED — el motor fiscal deja de contarlos.
//
// FASE A — Ventana legal rodante. Para cada empresa con FIEL, re-consulta los
// meses de emisión que TODAVÍA son legalmente cancelables (CFF Art. 29-A desde
// 2022: hasta la anual del ejercicio de emisión). La ventana es dinámica —
// 5..16 meses según la fecha — porque la fija de 3 meses tenía un hueco real:
// una factura de enero cancelada en noviembre jamás se detectaba.
//
// FASE B — Backlog histórico ÚNICO (automático). El backfill de XML importa
// TODO lo que el SAT entrega como STAMPED, y los paquetes XML incluyen CFDIs
// ya cancelados (el XML no trae estatus): una empresa recién onboardeada puede
// cargar años de facturas canceladas contadas como vigentes. Esta fase recorre
// una sola vez los periodos desde el PRIMER CFDI de la empresa hasta antes de
// la ventana rodante, con consultas de metadata. El progreso es durable en
// SatSyncRequest (mes hecho ⇔ METADATA_EMITIDOS y METADATA_RECIBIDOS en
// FINISHED, igual que el backfill de XML), y los años cerrados no pueden
// recibir cancelaciones nuevas, así que "hecho" es hecho para siempre. Sólo
// corre cuando el backfill de XML de la empresa ya terminó — antes, faltarían
// facturas que marcar y el mes quedaría "hecho" en falso.
//
// `historico=1&companyId=` fuerza el modo backlog PARA UNA EMPRESA en vez de
// la ventana rodante (drenado manual dirigido); re-llamar converge
// (`periodosPendientes` → 0). Incompatible con dryRun: las solicitudes se
// marcan FINISHED aunque no se escriba, y eso dejaría meses "hechos" sin
// aplicar — para validar formato usa dryRun sobre la ventana rodante.
//
// Cuotas: cada mes son 2 solicitudes de metadata al SAT (emitidos/recibidos),
// con reúso de 24h. El backlog va acotado por corrida y frena en cuota agotada
// (5002) — mismo espíritu que sat-backfill. SAT es asíncrono (submit→verify):
// un periodo puede quedar "pending" y resolverse en una corrida posterior.
// Idempotente: sólo STAMPED→CANCELLED.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Backlog: periodos por corrida y por empresa — cada periodo son 2 solicitudes
// de metadata al SAT; un tope corto evita quemar la cuota (5002) de un jalón.
const PERIODS_PER_RUN = 6;
/** Presupuesto de tiempo: dejar margen bajo maxDuration para responder. */
const TIME_BUDGET_MS = 240_000;

/**
 * Backlog histórico de una empresa: periodos desde su PRIMER CFDI hasta antes
 * de la ventana rodante, cuya verificación de cancelaciones no está terminada
 * (ambos lados METADATA con status FINISHED). Del más reciente al más viejo —
 * la probabilidad de cancelación relevante decae con la antigüedad.
 */
async function periodosHistoricosPendientes(
  companyId: string,
  monthsBack: number,
  now: Date
): Promise<Array<{ year: number; month: number }>> {
  const primera = await prisma.invoice.findFirst({
    where: { companyId },
    orderBy: { fecha: "asc" },
    select: { fecha: true },
  });
  if (!primera) return [];

  const terminados = await prisma.satSyncRequest.findMany({
    where: {
      companyId,
      tipo: { in: ["METADATA_EMITIDOS", "METADATA_RECIBIDOS"] },
      status: "FINISHED",
    },
    select: { year: true, month: true, tipo: true },
  });
  const porPeriodo = new Map<string, Set<string>>();
  for (const t of terminados) {
    const k = `${t.year}-${t.month}`;
    const s = porPeriodo.get(k) ?? new Set<string>();
    s.add(t.tipo);
    porPeriodo.set(k, s);
  }

  const backlog: Array<{ year: number; month: number }> = [];
  // Arranca justo antes de la ventana rodante (esa la cubre la fase A).
  const cursor = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  const inicio = new Date(primera.fecha.getFullYear(), primera.fecha.getMonth(), 1);
  while (cursor >= inicio) {
    const k = `${cursor.getFullYear()}-${cursor.getMonth() + 1}`;
    if ((porPeriodo.get(k)?.size ?? 0) < 2) {
      backlog.push({ year: cursor.getFullYear(), month: cursor.getMonth() + 1 });
    }
    cursor.setMonth(cursor.getMonth() - 1);
  }
  return backlog;
}

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
  const historico = url.searchParams.get("historico") === "1";
  const dryRun = ["1", "true", "yes"].includes((url.searchParams.get("dryRun") ?? "").toLowerCase());
  if (historico && !onlyCompanyId) {
    return NextResponse.json({ error: "historico=1 requiere companyId" }, { status: 400 });
  }
  if (historico && dryRun) {
    // Las solicitudes quedarían FINISHED (progreso "hecho") sin aplicar nada.
    return NextResponse.json(
      { error: "historico=1 no admite dryRun — valida el formato con dryRun sobre la ventana rodante." },
      { status: 400 },
    );
  }
  const startedAt = Date.now();

  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
      fielCer: { not: null },
      fielKey: { not: null },
      fielPassword: { not: null },
      ...(onlyCompanyId ? { id: onlyCompanyId } : {}),
    },
    select: { id: true, rfc: true, satBackfillCompletedAt: true },
  });

  const now = new Date();
  const periods = periodosHaciaAtras(now, monthsBack);

  let companiesProcessed = 0;
  let totalCancelled = 0;
  let totalWouldCancel = 0;
  let periodosPendientes = 0;
  let histPeriodos = 0;
  let histCompanies = 0;
  const errors: Array<{ companyId: string; rfc: string; error: string }> = [];

  // ── FASE A: ventana legal rodante (o el backlog dirigido con historico=1) ──
  for (const company of companies) {
    try {
      let delaEmpresa = periods;
      if (historico) {
        // El backlog sólo es confiable con el backfill de XML terminado: si
        // faltan facturas por importar, un mes marcado "hecho" hoy dejaría sus
        // canceladas sin marcar para siempre.
        if (!company.satBackfillCompletedAt) {
          errors.push({
            companyId: company.id,
            rfc: company.rfc,
            error: "El backfill de CFDIs aún no termina — el backlog histórico se pospone (corre solo al completarse).",
          });
          continue;
        }
        const backlog = await periodosHistoricosPendientes(company.id, monthsBack, now);
        delaEmpresa = backlog.slice(0, PERIODS_PER_RUN);
        periodosPendientes += Math.max(0, backlog.length - delaEmpresa.length);
        histPeriodos += delaEmpresa.length;
        if (delaEmpresa.length > 0) histCompanies++;
      }
      for (const { year, month } of delaEmpresa) {
        const res = await syncCancelacionesPeriodo(company.id, year, month, dryRun);
        if (res.ok && res.cancelled) totalCancelled += res.cancelled;
        if (res.ok && res.wouldCancel) totalWouldCancel += res.wouldCancel.length;
        if (!res.ok && res.error) {
          errors.push({ companyId: company.id, rfc: company.rfc, error: res.error });
          // Cuota del SAT agotada: frenar — la siguiente corrida retoma.
          if (res.error.includes("5002")) break;
        }
      }
      companiesProcessed++;
    } catch (e) {
      errors.push({ companyId: company.id, rfc: company.rfc, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── FASE B: backlog histórico AUTOMÁTICO (gap-driven, acotado por corrida) ─
  // En cada tick del cron avanza el backlog de las empresas listas (backfill de
  // XML terminado) sin esperar un disparo manual. Se OMITE en dryRun (progreso
  // "hecho" sin aplicar) y cuando ya se corrió en modo dirigido (historico=1).
  if (!historico && !dryRun) {
    for (const company of companies) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;
      if (!company.satBackfillCompletedAt) continue;

      const backlog = await periodosHistoricosPendientes(company.id, monthsBack, now);
      const chunk = backlog.slice(0, PERIODS_PER_RUN);
      periodosPendientes += Math.max(0, backlog.length - chunk.length);
      if (chunk.length === 0) continue;

      histCompanies++;
      for (const { year, month } of chunk) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) break;
        try {
          const res = await syncCancelacionesPeriodo(company.id, year, month, false);
          histPeriodos++;
          if (res.ok && res.cancelled) totalCancelled += res.cancelled;
          if (!res.ok && res.error) {
            errors.push({ companyId: company.id, rfc: company.rfc, error: res.error });
            if (res.error.includes("5002")) break;
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
    modoHistorico: historico,
    companies: companies.length,
    companiesProcessed,
    ...(dryRun ? { wouldCancelDetected: totalWouldCancel } : { cancelledDetected: totalCancelled }),
    // Backlog histórico (fase B o modo dirigido): lo tocado en esta corrida y
    // lo que queda DESPUÉS de ella (converge a 0 en corridas sucesivas).
    ...(dryRun
      ? { historico: { skipped: true } }
      : { historico: { companies: histCompanies, periodos: histPeriodos, pendientes: periodosPendientes } }),
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
