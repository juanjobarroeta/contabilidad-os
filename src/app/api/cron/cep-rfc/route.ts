import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { nivelPagoEmpresas } from "@/lib/billing/pagadores";
import { enriquecerCepEmpresa } from "@/lib/bancos/cep-enriquecer";
import { autoConciliarEmpresa } from "@/lib/bancos/auto-conciliar";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/cep-rfc   [?companyId=][&limit=N]
//
// Pide a Banxico el CEP de los SPEI ya importados y guarda el RFC de la
// contraparte. Es el dato que convierte la conciliación de «adivinar por monto»
// a «identificar por parte»: el RFC vale 120 puntos en el scorer, más que el
// importe exacto, y ningún estado de cuenta lo trae (medido: 0 de 172
// movimientos de un mes en un hospital real).
//
// NO ES GRATIS, a diferencia del barrido de contraparte: cada movimiento es una
// llamada a un proveedor externo. Por eso:
//   · gap-driven — sólo movimientos con clave de rastreo y CLABE, sin RFC y sin
//     `cepAt`;
//   · `cepAt` se sella SIEMPRE, haya CEP o no: un SPEI que Banxico no encuentra
//     (traspaso entre cuentas propias, clave mal leída) volvería a consultarse
//     en cada corrida para siempre;
//   · sólo empresas con pago vigente. Una empresa que dejó de pagar no genera
//     COGS, la misma regla que ya acota las extracciones de Syntage.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los demás.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TIME_BUDGET_MS = 240_000;
const POR_EMPRESA = 60;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!process.env.TLALOC_API_KEY?.trim()) {
    return NextResponse.json({ ok: true, omitido: "sin TLALOC_API_KEY configurada" });
  }

  const url = new URL(req.url);
  const soloEmpresa = url.searchParams.get("companyId");
  const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
  const porEmpresa = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 500) : POR_EMPRESA;

  // Empresas CON movimientos pendientes de CEP: agrupar primero evita recorrer
  // toda la cartera para descubrir que no hay nada que hacer.
  const pendientes = await prisma.bankTransaction.groupBy({
    by: ["companyId"],
    where: {
      ...(soloEmpresa ? { companyId: soloEmpresa } : {}),
      claveRastreo: { not: null },
      contraparteClabe: { not: null },
      contraparteRfc: null,
      cepAt: null,
    },
    _count: { _all: true },
  });
  if (pendientes.length === 0) return NextResponse.json({ ok: true, empresas: 0, conRfc: 0 });

  const niveles = await nivelPagoEmpresas(pendientes.map((p) => p.companyId));
  const iniciado = Date.now();
  const resultados: Record<string, unknown>[] = [];
  let conRfc = 0;
  let consultados = 0;

  for (const p of pendientes) {
    if (Date.now() - iniciado > TIME_BUDGET_MS) break;
    if ((niveles.get(p.companyId) ?? "NINGUNO") === "NINGUNO") continue;
    const r = await enriquecerCepEmpresa(p.companyId, { max: porEmpresa });
    conRfc += r.conRfc;
    consultados += r.consultados;
    // Con RFCs nuevos hay identidad donde antes sólo había monto: se vuelve a
    // conciliar en automático. Es lo que cierra el círculo desde la subida —
    // importar → CEP → conciliar — sin que el usuario tenga que volver.
    if (r.conRfc > 0) {
      try {
        await autoConciliarEmpresa(p.companyId);
      } catch (e) {
        console.error(`[cep-rfc] auto-conciliar tras CEP falló para ${p.companyId}:`, e);
      }
    }
    if (r.consultados > 0) {
      resultados.push({ companyId: p.companyId, consultados: r.consultados, conRfc: r.conRfc, sinCep: r.sinCep, errores: r.errores });
    }
    if (r.primerError) console.error(`[cep-rfc] ${p.companyId}: ${r.primerError}`);
  }

  console.log(`[cep-rfc] ${consultados} consultas · ${conRfc} con RFC · ${resultados.length} empresa(s)`);
  return NextResponse.json({ ok: true, empresas: resultados.length, consultados, conRfc, resultados });
}

export async function POST(req: Request) {
  return withCronLock("cron:cep-rfc", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:cep-rfc", () => handle(req));
}
