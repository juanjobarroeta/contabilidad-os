import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import {
  derivarInsumosBackfill,
  empresasHospitalParaBackfill,
  etiquetarControlados,
  reiniciarProgresoInsumos,
  type BackfillInsumosResultado,
} from "@/lib/hospital/insumos-cfdi";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/hospital-insumos-backfill[?companyId=…&afterId=…]
//
// Drenado histórico del catálogo/kardex de farmacia desde los CFDIs de las
// empresas con módulo HOSPITAL (docs/HOSPITAL.md §4). Cursor por id de factura
// en BackfillProgreso (job hospital-insumos); cada corrida avanza hasta agotar
// su presupuesto y guarda dónde se quedó. Idempotente: repetir no duplica.
//
// Sin companyId atiende varias empresas por corrida — primero las que no han
// terminado su carga inicial, después las terminadas, que sólo recogen lo
// importado desde la última pasada (el cursor por id sigue hacia adelante).
//
//   reiniciar=1   → el cursor vuelve al principio (tras cambiar reglas).
//   recalcular=1  → además BORRA, página por página, los movimientos
//                   derivados (ENTRADA_COMPRA/SALIDA_VENTA con CFDI y SIN
//                   lote) antes de rederivarlos. Los que farmacia ya amarró a
//                   un lote son recepción física y no se tocan; los AJUSTE,
//                   MERMA, etc. tampoco. Exige companyId explícito.
//   etiquetar=1   → tras derivar, propone grupo de control y sustancia activa
//                   a los insumos derivados que nadie ha etiquetado (los
//                   nuevos ya nacen etiquetados). No toca lo capturado a mano.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los demás crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGE = 100;
const TIME_BUDGET_MS = 240_000;
const EMPRESAS_POR_CORRIDA = 10;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const onlyCompanyId = url.searchParams.get("companyId");
  const afterId = url.searchParams.get("afterId");
  const reiniciar = url.searchParams.get("reiniciar") === "1";
  const recalcular = url.searchParams.get("recalcular") === "1";
  const etiquetar = url.searchParams.get("etiquetar") === "1";
  if (recalcular && !onlyCompanyId) {
    return NextResponse.json(
      { error: "recalcular=1 requiere companyId explícito (borra los movimientos derivados del kardex)" },
      { status: 400 }
    );
  }
  const startedAt = Date.now();

  const objetivos = onlyCompanyId
    ? [onlyCompanyId]
    : await empresasHospitalParaBackfill(prisma, EMPRESAS_POR_CORRIDA);

  if (onlyCompanyId && (reiniciar || recalcular)) {
    await reiniciarProgresoInsumos(prisma, onlyCompanyId);
  }

  let borrados = 0;
  let etiquetados = 0;
  const empresas: Array<{ companyId: string } & BackfillInsumosResultado> = [];
  for (const companyId of objetivos) {
    const restante = TIME_BUDGET_MS - (Date.now() - startedAt);
    if (restante <= 5_000) break;
    const r = await derivarInsumosBackfill(prisma, companyId, {
      ...(afterId && onlyCompanyId ? { afterId } : {}),
      budgetMs: restante,
      page: PAGE,
      // El borrado va POR PÁGINA, no de golpe al principio: así lo único
      // inconsistente durante la rederivación es la página en vuelo.
      antesDePagina: recalcular
        ? async (ids) => {
            const { count } = await prisma.hospMovimientoInsumo.deleteMany({
              where: {
                companyId,
                invoiceId: { in: ids },
                loteId: null,
                tipo: { in: ["ENTRADA_COMPRA", "SALIDA_VENTA"] },
              },
            });
            borrados += count;
          }
        : undefined,
    });
    empresas.push({ companyId, ...r });
    if (etiquetar) etiquetados += (await etiquetarControlados(prisma, companyId)).etiquetados;
  }

  const summary = {
    ok: true,
    empresas,
    pendientes: empresas.filter((e) => !e.completado).length,
    procesados: empresas.reduce((s, e) => s + e.procesados, 0),
    insumos: empresas.reduce((s, e) => s + e.insumos, 0),
    movimientos: empresas.reduce((s, e) => s + e.movimientos, 0),
    ...(recalcular ? { borrados } : {}),
    ...(etiquetar ? { etiquetados } : {}),
    // Compatibilidad con el encadenado por cursor de una sola empresa.
    nextAfterId: onlyCompanyId ? (empresas[0]?.nextAfterId ?? null) : null,
    completado: empresas.every((e) => e.completado),
    elapsedMs: Date.now() - startedAt,
  };
  console.log("[cron/hospital-insumos-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:hospital-insumos-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:hospital-insumos-backfill", () => handle(req));
}
