import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { syncCancelacionesPeriodo } from "@/lib/sat-sync";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/sat-cancel-sync
//
// Detecta CFDIs cancelados en el SAT (descarga de metadata) y revierte su
// efecto marcándolos CANCELLED — el motor fiscal deja de contarlos. Para cada
// empresa con FIEL, corre el mes actual + los `months-1` anteriores (default 3:
// las cancelaciones suelen ocurrir semanas/meses después de la emisión).
//
// Misma cadencia submit→verify que el sync de XML: SAT es asíncrono, así que un
// periodo puede quedar "pending" y resolverse en una corrida posterior. Seguro
// de re-ejecutar (idempotente: sólo STAMPED→CANCELLED).
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_MONTHS_BACK = 3;
// historico=1: periodos por corrida — cada periodo son 2 solicitudes de
// metadata al SAT; un tope corto evita quemar la cuota (5002) de un jalón.
const PERIODS_PER_RUN = 6;

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
  // Arranca justo antes de la ventana rodante (esa la cubre el cron normal).
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

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const monthsParam = parseInt(url.searchParams.get("months") ?? "", 10);
  const monthsBack = Number.isFinite(monthsParam) ? Math.min(Math.max(monthsParam, 1), 12) : DEFAULT_MONTHS_BACK;
  const onlyCompanyId = url.searchParams.get("companyId");
  // historico=1 (requiere companyId): en vez de la ventana rodante, cubre los
  // periodos HISTÓRICOS de la empresa (desde su primer CFDI) que aún no tienen
  // la verificación de cancelaciones terminada (ambos lados METADATA FINISHED),
  // del más reciente al más viejo, con tope por corrida y freno en cuota 5002.
  // Re-llamar converge: cada corrida avanza el backlog y verifica solicitudes
  // pendientes de corridas anteriores.
  const historico = url.searchParams.get("historico") === "1";
  if (historico && !onlyCompanyId) {
    return NextResponse.json({ error: "historico=1 requiere companyId" }, { status: 400 });
  }
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
    select: { id: true, rfc: true },
  });

  const now = new Date();
  const periods: Array<{ year: number; month: number }> = [];
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    periods.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  let companiesProcessed = 0;
  let totalCancelled = 0;
  let totalWouldCancel = 0;
  let periodosPendientes = 0;
  const errors: Array<{ companyId: string; rfc: string; error: string }> = [];

  for (const company of companies) {
    try {
      let delaEmpresa = periods;
      if (historico) {
        const backlog = await periodosHistoricosPendientes(company.id, monthsBack, now);
        delaEmpresa = backlog.slice(0, PERIODS_PER_RUN);
        periodosPendientes += Math.max(0, backlog.length - delaEmpresa.length);
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

  const summary = {
    ok: true,
    dryRun,
    historico,
    companies: companies.length,
    companiesProcessed,
    ...(dryRun ? { wouldCancelDetected: totalWouldCancel } : { cancelledDetected: totalCancelled }),
    // historico: periodos aún sin verificación terminada DESPUÉS de esta
    // corrida (re-llamar hasta que llegue a 0).
    ...(historico ? { periodosPendientes } : {}),
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
