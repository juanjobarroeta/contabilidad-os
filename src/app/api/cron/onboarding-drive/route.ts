import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { empresasPorAtender, type ConteosEmpresa } from "@/lib/onboarding/estado";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/onboarding-drive   [?companyId=<id>][&maxEmpresas=N]
//
// ORQUESTADOR de la carga inicial. Una empresa nueva depende de una CADENA:
// el SAT entrega XMLs → de ellos se derivan impuestos, contraparte y vigencia.
// Cada eslabón vive en su cron gap-driven, y cada cron corre cada 6 h
// repartiendo su presupuesto entre TODO el portafolio. Para una empresa recién
// onboardeada eso significa días o semanas hasta quedar al corriente — y en la
// práctica alguien terminaba empujando los crons a mano, cliente por cliente.
//
// Este cron hace exactamente eso, solo: encuentra a las empresas más atrasadas
// en su carga y empuja, POR EMPRESA, el cron del primer eslabón que les falta
// (empujar los de más adelante sería trabajo en vano hasta que el previo
// avance). Corre seguido porque cuando nadie está cargando es un no-op barato:
// una sola consulta agregada y se acabó.
//
// El empuje es un self-fetch al endpoint del cron correspondiente con
// `companyId=` — el mismo mecanismo del scheduler, reutilizando intactos su
// auth, su candado y su lógica. No duplica nada.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Empresas atendidas por corrida: pocas, para dedicarles cupo de verdad. */
const MAX_EMPRESAS = 3;
const TIME_BUDGET_MS = 240_000;
/** Cupo que se le pide a cada cron empujado — generoso: son trabajos locales
 *  salvo vigencia, que de todos modos no consume cuota del SAT. */
const CUPO: Record<string, number> = {
  "sat-rawxml-backfill": 2000,
  "invoice-taxes-backfill": 5000,
  "invoice-contraparte-backfill": 20000,
  "sat-vigencia-sync": 500,
};

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

function baseUrl(): string {
  return `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

/** Empuja un cron para UNA empresa. 409 = ya estaba corriendo (no es error). */
async function empujar(cron: string, companyId: string): Promise<{ ok: boolean; status: number }> {
  const secret = process.env.CRON_SECRET as string;
  const limit = CUPO[cron] ?? 1000;
  const res = await fetch(
    `${baseUrl()}/api/cron/${cron}?companyId=${encodeURIComponent(companyId)}&limit=${limit}`,
    { method: "POST", headers: { "x-cron-secret": secret } },
  );
  return { ok: res.ok || res.status === 409, status: res.status };
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const onlyCompanyId = url.searchParams.get("companyId");
  const maxParam = parseInt(url.searchParams.get("maxEmpresas") ?? "", 10);
  const maxEmpresas = Number.isFinite(maxParam) ? Math.min(Math.max(maxParam, 1), 20) : MAX_EMPRESAS;
  const startedAt = Date.now();

  // UNA consulta agregada para todo el portafolio: los conteos por empresa que
  // deciden qué falta. Con N empresas esto es una consulta, no N.
  const filas = await prisma.$queryRaw<
    Array<{
      companyId: string;
      total: bigint;
      con_xml: bigint;
      con_impuestos: bigint;
      con_contraparte: bigint;
      con_vigencia: bigint;
      backfill_completo: boolean;
    }>
  >`
    SELECT c.id AS "companyId",
           count(i.id) AS total,
           count(i.id) FILTER (WHERE i."rawXml" IS NOT NULL) AS con_xml,
           count(i.id) FILTER (WHERE EXISTS (SELECT 1 FROM "InvoiceTax" t WHERE t."invoiceId" = i.id)) AS con_impuestos,
           count(i.id) FILTER (WHERE i."contraparteNombre" IS NOT NULL) AS con_contraparte,
           count(i.id) FILTER (WHERE i."vigenciaCheckedAt" IS NOT NULL) AS con_vigencia,
           (c."satBackfillCompletedAt" IS NOT NULL) AS backfill_completo
    FROM "Company" c
    LEFT JOIN "Invoice" i ON i."companyId" = c.id
    WHERE c."isActive" = true
      AND c."fielCer" IS NOT NULL
      ${onlyCompanyId ? Prisma.sql`AND c.id = ${onlyCompanyId}` : Prisma.empty}
    GROUP BY c.id, c."satBackfillCompletedAt"`;

  const conteos: ConteosEmpresa[] = filas.map((f) => ({
    companyId: f.companyId,
    total: Number(f.total),
    conXml: Number(f.con_xml),
    conImpuestos: Number(f.con_impuestos),
    conContraparte: Number(f.con_contraparte),
    conVigencia: Number(f.con_vigencia),
    backfillCompleto: f.backfill_completo,
  }));

  const aAtender = empresasPorAtender(conteos, maxEmpresas);

  const empujes: Array<{ companyId: string; cron: string; status: number }> = [];
  for (const emp of aAtender) {
    for (const cron of emp.crons) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;
      try {
        const r = await empujar(cron, emp.companyId);
        empujes.push({ companyId: emp.companyId, cron, status: r.status });
      } catch (e) {
        empujes.push({ companyId: emp.companyId, cron, status: 0 });
        console.error("[cron/onboarding-drive] empuje falló:", cron, e instanceof Error ? e.message : e);
      }
    }
  }

  const summary = {
    ok: true,
    empresasEvaluadas: conteos.length,
    // Empresas que todavía no terminan su carga inicial. Converge a 0 y ahí el
    // cron se vuelve un no-op de una sola consulta.
    empresasCargando: conteos.filter((c) => {
      const e = empresasPorAtender([c], 1);
      return e.length > 0;
    }).length,
    atendidas: aAtender.map((e) => ({
      companyId: e.companyId,
      crons: e.crons,
      etapas: e.etapas.map((x) => ({ clave: x.clave, pct: x.pct, completa: x.completa })),
    })),
    empujes,
    elapsedMs: Date.now() - startedAt,
  };
  console.log("[cron/onboarding-drive] done:", JSON.stringify({ ...summary, atendidas: aAtender.length }));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:onboarding-drive", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:onboarding-drive", () => handle(req));
}
