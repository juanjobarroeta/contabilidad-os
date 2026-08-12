import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { syncCancelacionesPeriodo } from "@/lib/sat-sync";
import {
  mesesBacklogCancelaciones,
  mesesVentanaCancelable,
  ordenEmpresasPorAntiguedad,
} from "@/lib/sat-cancelaciones";

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
// una sola vez los meses históricos con consultas de metadata. El gate es POR
// MES: elegible en cuanto SU XML está completo (EMITIDOS+RECIBIDOS FINISHED —
// todas sus facturas ya existen), sin esperar a que el backfill de 5 años
// termine entero; así el estatus de cancelación va un tick detrás de cada mes
// importado, no días detrás del backfill completo. El progreso es durable en
// SatSyncRequest (mes hecho ⇔ METADATA_EMITIDOS y METADATA_RECIBIDOS en
// FINISHED), y los años cerrados no pueden recibir cancelaciones nuevas, así
// que "hecho" es hecho para siempre.
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
// Presupuesto de la fase A. La fase B (histórico de empresas nuevas) corre
// DESPUÉS, así que sin un tope aquí se quedaba sin tiempo y no avanzaba nunca.
const FASE_A_BUDGET_MS = 120_000;
/** Presupuesto de tiempo: dejar margen bajo maxDuration para responder. */
const TIME_BUDGET_MS = 240_000;

/**
 * Backlog de la empresa: meses con XML completo pero metadata pendiente,
 * excluyendo la ventana rodante. La decisión es pura (mesesBacklogCancelaciones);
 * aquí sólo la consulta.
 */
async function periodosHistoricosPendientes(
  companyId: string,
  ventanaRodante: Array<{ year: number; month: number }>,
): Promise<Array<{ year: number; month: number }>> {
  const terminados = await prisma.satSyncRequest.findMany({
    where: {
      companyId,
      status: "FINISHED",
      tipo: { in: ["EMITIDOS", "RECIBIDOS", "METADATA_EMITIDOS", "METADATA_RECIBIDOS"] },
    },
    select: { year: true, month: true, tipo: true },
  });
  return mesesBacklogCancelaciones(terminados, ventanaRodante);
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
  // periodos= (sólo modo dirigido): meses del backlog por corrida. El default
  // corto cuida la cuota; un drenado manual supervisado puede pedir más.
  const periodosParam = parseInt(url.searchParams.get("periodos") ?? "", 10);
  const periodosPorCorrida = Number.isFinite(periodosParam)
    ? Math.min(Math.max(periodosParam, 1), 24)
    : PERIODS_PER_RUN;
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

  const empresasSinOrden = await prisma.company.findMany({
    where: {
      isActive: true,
      fielCer: { not: null },
      fielKey: { not: null },
      fielPassword: { not: null },
      ...(onlyCompanyId ? { id: onlyCompanyId } : {}),
    },
    select: { id: true, rfc: true },
  });

  // Orden JUSTO: primero las empresas nunca consultadas, luego las más
  // antiguas. Recorrer siempre en el mismo orden dejaba a las últimas sin
  // turno cuando se agotaba el presupuesto de tiempo — y una empresa recién
  // onboardeada, que es justo la que más metadata necesita, se quedaba en cero
  // para siempre. Con esto, la empresa nueva va al frente.
  const ultimaMetadata = await prisma.satSyncRequest.groupBy({
    by: ["companyId"],
    where: { tipo: { in: ["METADATA_EMITIDOS", "METADATA_RECIBIDOS"] } },
    _max: { createdAt: true },
  });
  const ultimaPorEmpresa = new Map<string, Date | null>(
    ultimaMetadata.map((r) => [r.companyId, r._max.createdAt ?? null]),
  );
  const companies = ordenEmpresasPorAntiguedad(empresasSinOrden, ultimaPorEmpresa);

  const now = new Date();
  const periods = periodosHaciaAtras(now, monthsBack);

  let companiesProcessed = 0;
  let totalCancelled = 0;
  let totalWouldCancel = 0;
  // Renglones de metadata leídos: distingue "no hay cancelaciones" (revisados
  // altos, cancelados 0) de "el parser no lee nada" (revisados 0 con CFDIs).
  let totalRevisados = 0;
  let periodosPendientes = 0;
  let histPeriodos = 0;
  let histCompanies = 0;
  const errors: Array<{ companyId: string; rfc: string; error: string }> = [];

  // ── FASE A: ventana legal rodante (o el backlog dirigido con historico=1) ──
  // Con presupuesto propio: sin él, la fase A (todas las empresas × la ventana
  // completa) consumía el tiempo entero y la fase B —el histórico de las
  // empresas nuevas— nunca llegaba a correr. Lo que quede sin cubrir lo retoma
  // la siguiente corrida, que además arranca por las empresas más atrasadas.
  let faseATruncada = false;
  for (const company of companies) {
    if (!onlyCompanyId && Date.now() - startedAt > FASE_A_BUDGET_MS) {
      faseATruncada = true;
      break;
    }
    try {
      let delaEmpresa = periods;
      if (historico) {
        const backlog = await periodosHistoricosPendientes(company.id, periods);
        delaEmpresa = backlog.slice(0, periodosPorCorrida);
        periodosPendientes += Math.max(0, backlog.length - delaEmpresa.length);
        histPeriodos += delaEmpresa.length;
        if (delaEmpresa.length > 0) histCompanies++;
      }
      for (const { year, month } of delaEmpresa) {
        const res = await syncCancelacionesPeriodo(company.id, year, month, dryRun);
        if (res.ok && res.cancelled) totalCancelled += res.cancelled;
        if (res.ok && res.wouldCancel) totalWouldCancel += res.wouldCancel.length;
        if (res.ok && res.checked) totalRevisados += res.checked;
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

      const backlog = await periodosHistoricosPendientes(company.id, periods);
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
          if (res.ok && res.checked) totalRevisados += res.checked;
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
    // La fase A se cortó por presupuesto: la siguiente corrida retoma por las
    // empresas más atrasadas (el orden es por antigüedad de consulta).
    faseATruncada,
    ...(dryRun ? { wouldCancelDetected: totalWouldCancel } : { cancelledDetected: totalCancelled }),
    // Renglones de metadata leídos en los paquetes descargados. 0 con CFDIs en
    // los periodos = el parser no está leyendo el paquete (formato), no "no
    // hay cancelaciones".
    revisados: totalRevisados,
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
