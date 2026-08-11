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
  const startedAt = Date.now();

  // Sin companyId, el cron elige solo a quién le falta la carga inicial: el
  // drenado histórico deja de depender de que alguien encadene cursores.
  const objetivo = onlyCompanyId ?? (await empresasPendientes(prisma, "refacciones", 1))[0] ?? null;
  if (objetivo && reiniciar) await reiniciarProgreso(prisma, objetivo, "refacciones");

  const where = {
    tipo: { in: ["INGRESO", "EGRESO"] as InvoiceType[] },
    status: { not: "CANCELLED" as const },
    rawXml: { contains: 'NoIdentificacion="' },
    company: { modules: { some: { modulo: "AUTOMOTRIZ" as ModuloApp, habilitado: true } } },
    ...(objetivo ? { companyId: objetivo } : {}),
  };

  const guardado = objetivo ? await leerProgreso(prisma, objetivo, "refacciones") : null;
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
