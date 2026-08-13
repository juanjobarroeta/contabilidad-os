import { NextResponse } from "next/server";
import type { InvoiceType, ModuloApp } from "@prisma/client";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { derivarRefaccionesDesdeCfdiSiAplica } from "@/lib/automotriz/auto-refaccion";
import {
  empresasPendientes,
  guardarProgreso,
  leerProgreso,
  reiniciarProgreso,
} from "@/lib/automotriz/backfill-progreso";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/refacciones-backfill?companyId=…[&afterId=…]
//
// Drenado HISTÓRICO del catálogo/kardex de refacciones: recorre los CFDIs de
// ingreso/egreso con números de parte (prefiltro NoIdentificacion=) y deriva
// entradas/salidas. Pensado como corrida manual encadenada por cursor
// (afterId → nextAfterId, null = terminó) — hacia adelante, la derivación
// INLINE del import mantiene el kardex al día sin este cron.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los demás crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGE = 200;
const TIME_BUDGET_MS = 240_000;

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
  const reiniciar = url.searchParams.get("reiniciar") === "1";
  // recalcular=1: BORRA los movimientos derivados antes de volver a barrer.
  //
  // `reiniciar` sólo mueve el cursor y el kardex es idempotente por
  // @@unique([refaccionId, invoiceId, tipo]), así que re-barrer devuelve
  // «movimientos: 0» — el catálogo se actualiza (partes) pero el kardex viejo
  // queda intacto. Sin esto, arreglar la ClaveUnidad no cambia un solo
  // movimiento ya escrito.
  //
  // Los AJUSTE NO se borran: son el conteo físico que alguien capturó a mano y
  // no se pueden volver a derivar de ningún CFDI. Sólo se rehace lo que nació
  // de una factura.
  const recalcular = url.searchParams.get("recalcular") === "1";
  if (recalcular && !onlyCompanyId) {
    return NextResponse.json(
      { error: "recalcular=1 requiere companyId explícito (borra los movimientos derivados del kardex)" },
      { status: 400 }
    );
  }
  const startedAt = Date.now();

  // Sin companyId, el cron elige solo a quién le falta la carga inicial: el
  // drenado histórico deja de depender de que alguien encadene cursores.
  const objetivo = onlyCompanyId ?? (await empresasPendientes(prisma, "refacciones", 1))[0] ?? null;
  // El progreso se LEE antes de decidir si se reinicia: `recalcular` que cae a
  // mitad de un barrido debe CONTINUARLO, no empezarlo de cero.
  //
  // Sin esto no había forma de terminar un recalcular. Con la bandera, el
  // cursor volvía al principio en cada ronda (bucle infinito); sin ella, el
  // barrido cambiaba de semántica a media corrida y saltaba justo lo que
  // faltaba por rehacer — y reportaba «completado: true». Visto en producción:
  // 66,200 escaneadas con completado:false, y la siguiente ronda sin bandera
  // cerró el barrido con «derivadas: 0» dejando la cola con datos viejos.
  const previo = objetivo ? await leerProgreso(prisma, objetivo, "refacciones") : null;
  const continuandoRecalculo = recalcular && previo != null && !previo.completado;
  if (objetivo && (reiniciar || (recalcular && !continuandoRecalculo))) {
    await reiniciarProgreso(prisma, objetivo, "refacciones");
  }

  // El borrado va POR PÁGINA, no de golpe al principio.
  //
  // Borrar los 143,932 movimientos de una empresa antes de empezar deja el
  // kardex casi vacío durante toda la re-derivación — que en Margom son más de
  // veinte corridas de cuatro minutos. Durante esa hora larga el estado de
  // resultados reporta refacciones al 2% de su costo real y NADA en la pantalla
  // dice que el dato está a medio reconstruir. Un tablero a medias miente peor
  // que uno viejo, porque parece terminado.
  //
  // Borrando la página justo antes de rederivarla, lo único inconsistente son
  // las ~400 facturas en vuelo, y sólo por los segundos que tarda ese lote.
  let borrados = 0;

  const where = {
    tipo: { in: ["INGRESO", "EGRESO"] as InvoiceType[] },
    status: { not: "CANCELLED" as const },
    rawXml: { contains: 'NoIdentificacion="' },
    company: { modules: { some: { modulo: "AUTOMOTRIZ" as ModuloApp, habilitado: true } } },
    ...(objetivo ? { companyId: objetivo } : {}),
  };

  const guardado = continuandoRecalculo ? previo : (objetivo ? await leerProgreso(prisma, objetivo, "refacciones") : null);
  let lastId: string | undefined =
    url.searchParams.get("afterId") ?? (guardado && !guardado.completado ? (guardado.cursor ?? undefined) : undefined);
  let barridoCompleto = true;
  let scanned = 0;
  let partes = 0;
  let movimientos = 0;

  while (true) {
    if (Date.now() - startedAt >= TIME_BUDGET_MS) {
      barridoCompleto = false;
      break;
    }
    const page = await prisma.invoice.findMany({
      where: { ...where, ...(lastId ? { id: { gt: lastId } } : {}) },
      select: { id: true, companyId: true, tipo: true, fecha: true, rawXml: true },
      orderBy: { id: "asc" },
      take: PAGE,
    });
    if (page.length === 0) break;

    // Los AJUSTE se respetan siempre: son el conteo físico capturado a mano y
    // no se pueden re-derivar de ningún CFDI.
    if (recalcular) {
      borrados += (
        await prisma.refaccionMovimiento.deleteMany({
          where: {
            invoiceId: { in: page.map((p) => p.id) },
            tipo: { in: ["ENTRADA_COMPRA", "SALIDA_VENTA"] },
          },
        })
      ).count;
    }

    for (const inv of page) {
      scanned++;
      const r = await derivarRefaccionesDesdeCfdiSiAplica(prisma, {
        companyId: inv.companyId,
        invoiceId: inv.id,
        tipo: inv.tipo,
        fecha: inv.fecha,
        rawXml: inv.rawXml,
      });
      if (r) {
        partes += r.partes;
        movimientos += r.movimientos;
      }
    }

    lastId = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }

  if (objetivo) {
    await guardarProgreso(prisma, objetivo, "refacciones", {
      cursor: lastId ?? null,
      procesados: scanned,
      derivados: movimientos,
      completado: barridoCompleto,
    });
  }

  const summary = {
    ok: true,
    companyId: objetivo,
    scanned,
    partes,
    movimientos,
    ...(recalcular ? { borrados } : {}),
    completado: barridoCompleto,
    nextAfterId: !barridoCompleto ? (lastId ?? null) : null,
    elapsedMs: Date.now() - startedAt,
  };
  console.log("[cron/refacciones-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:refacciones-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:refacciones-backfill", () => handle(req));
}
