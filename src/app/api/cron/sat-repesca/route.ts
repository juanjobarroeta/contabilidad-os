import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { submitSatSync, verifyAndImportSatSync } from "@/lib/sat-sync";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/sat-repesca?companyId=<id>&periodos=YYYY-MM,YYYY-MM[&dryRun=1]
//
// Vuelve a pedirle al SAT los CFDIs de periodos ESPECÍFICOS. Existe porque
// sat-backfill no puede: salta cualquier mes ya marcado hecho
// (`if (done.has(...)) continue`), y `finishedPeriods` lo marca hecho cuando las
// dos solicitudes llegan a FINISHED — SIN IMPORTAR cuántas facturas entraron.
//
// Así se quedaron ocho meses de MARGOM, medidos contra sus vecinos:
//
//   2022-01  63 fact  $27,304.54     2023-08  AUSENTE
//   2022-02  49       $27,337.65     2024-01  36 fact  $1,482,667.27
//   2022-03  80       $35,500.62     2025-04  AUSENTE
//   2022-05  47       $21,878.58
//   2022-06   3       $2,078.37
//
// ~$500M de ingreso y ~5,200 facturas. Cada mes se pidió, volvió FINISHED,
// importó casi nada y quedó «hecho» para siempre. Las unidades vendidas en esos
// meses nunca se dieron de baja: es una de las dos causas del piso inflado.
//
// AVISO DE CUOTA (5002). El SAT limita las solicitudes DE POR VIDA por
// (RFC + rango + tipo). Estos periodos pueden tenerla quemada, y esperar NO la
// libera. `force` salta el reúso de 24h pero no la cuota vitalicia.
//
// Si sale 5002, esta ruta se detiene y lo reporta en vez de insistir. Quedan dos
// salidas, ninguna implementada aquí todavía: variar el rango de fechas (la que
// documenta el propio código del SAT — pedir el mes en tramos diarios es una
// llave de cuota distinta, a costa de ~30 solicitudes en vez de 2) o ir por
// Syntage, cuyo cliente ya tiene el extractor "invoice".
//
// `dryRun=1` dice qué haría sin gastar una sola solicitud.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TIME_BUDGET_MS = 240_000;
const MAX_PERIODOS = 24;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

/** "2025-04,2023-08" → [{año,mes}]. Ignora lo que no parsea, sin adivinar. */
export function parsePeriodos(raw: string): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  for (const tok of raw.split(",")) {
    const m = tok.trim().match(/^(\d{4})-(\d{1,2})$/);
    if (!m) continue;
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (year < 2000 || year > 2100 || month < 1 || month > 12) continue;
    if (!out.some((p) => p.year === year && p.month === month)) out.push({ year, month });
  }
  return out;
}

interface ResultadoPeriodo {
  periodo: string;
  /** Facturas de INGRESO que ya teníamos de ese mes, antes de repescar. */
  facturasAntes: number;
  facturasDespues?: number;
  importadas?: number;
  cuotaAgotada?: boolean;
  error?: string;
}

async function contarIngresos(companyId: string, year: number, month: number): Promise<number> {
  return prisma.invoice.count({
    where: {
      companyId,
      tipo: "INGRESO",
      status: { not: "CANCELLED" },
      fecha: { gte: new Date(Date.UTC(year, month - 1, 1)), lt: new Date(Date.UTC(year, month, 1)) },
    },
  });
}

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const companyId = params.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  const raw = params.get("periodos");
  if (!raw) {
    return NextResponse.json(
      { error: "periodos requerido, p.ej. periodos=2025-04,2023-08" },
      { status: 400 },
    );
  }
  const periodos = parsePeriodos(raw).slice(0, MAX_PERIODOS);
  if (periodos.length === 0) {
    return NextResponse.json({ error: "ningún periodo válido en `periodos`" }, { status: 400 });
  }
  const dryRun = params.get("dryRun") === "1";
  const startedAt = Date.now();

  const empresa = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, razonSocial: true },
  });
  if (!empresa) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  const resultados: ResultadoPeriodo[] = [];
  let cuotaAgotada = false;

  for (const { year, month } of periodos) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    const periodo = `${year}-${String(month).padStart(2, "0")}`;
    const facturasAntes = await contarIngresos(companyId, year, month);

    if (dryRun) {
      resultados.push({ periodo, facturasAntes });
      continue;
    }

    try {
      // force=true: sin esto reutiliza la solicitud de las últimas 24h, que es
      // justo la que ya volvió vacía.
      const sub = await submitSatSync(companyId, year, month, true);
      if (!sub.ok) {
        const esCuota = sub.error.includes("5002");
        if (esCuota) cuotaAgotada = true;
        resultados.push({ periodo, facturasAntes, cuotaAgotada: esCuota, error: sub.error });
        // La cuota vitalicia no se libera esperando: no vale la pena seguir
        // pidiendo los demás meses por la vía mensual.
        if (esCuota) break;
        continue;
      }
      const ver = await verifyAndImportSatSync(
        companyId,
        sub.emitidosRequestId,
        sub.recibidosRequestId,
      );
      resultados.push({
        periodo,
        facturasAntes,
        facturasDespues: await contarIngresos(companyId, year, month),
        importadas: ver.ok && typeof ver.imported === "number" ? ver.imported : 0,
        error: ver.ok ? undefined : ver.error,
      });
    } catch (e) {
      resultados.push({
        periodo,
        facturasAntes,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const summary = {
    ok: true,
    companyId,
    rfc: empresa.rfc,
    dryRun,
    periodosPedidos: periodos.length,
    resultados,
    cuotaAgotada,
    elapsedMs: Date.now() - startedAt,
    nota: cuotaAgotada
      ? "El SAT agotó la cuota DE POR VIDA de algún periodo (5002). Esperar no la libera: " +
        "hay que variar el rango de fechas o usar Syntage (extractor \"invoice\")."
      : "El SAT es asíncrono: un periodo puede quedar pendiente y resolverse en otra corrida. " +
        "Re-ejecutable; compara facturasAntes con facturasDespues.",
  };
  console.log("[cron/sat-repesca]", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:sat-repesca", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:sat-repesca", () => handle(req));
}
