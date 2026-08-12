import { NextResponse } from "next/server";
import type { ModuloApp } from "@prisma/client";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { derivarNominaCostoSiAplica } from "@/lib/automotriz/auto-nomina";
import {
  empresasPendientes,
  guardarProgreso,
  leerProgreso,
  reiniciarProgreso,
} from "@/lib/automotriz/backfill-progreso";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/nomina-costo-backfill?companyId=…[&afterId=…][&reiniciar=1]
//
// Drenado histórico del COSTO DE NÓMINA por línea de negocio: recorre los CFDIs
// de nómina y clasifica cada recibo (taller/ventas/refacciones/admin) con el
// Puesto del complemento, guardando también la sucursal (Departamento). Es lo
// que permite que el estado de resultados muestre el margen real del taller en
// vez de ingreso sin costo.
//
// Cursor durable en BackfillProgreso: sin companyId elige solo a la empresa que
// aún no termina, y el scheduler lo drena sin que nadie encadene llamadas.
//
// recalcular=1 borra lo ya derivado de esa empresa y lo vuelve a leer del XML
// —para cuando cambia la extracción (p. ej. un atributo que antes se leía del
// nodo equivocado)— respetando las líneas corregidas a mano (lineaManual).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGE = 500;
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
  const recalcular = url.searchParams.get("recalcular") === "1";
  const startedAt = Date.now();

  const objetivo = onlyCompanyId ?? (await empresasPendientes(prisma, "nomina", 1))[0] ?? null;
  if (objetivo && (reiniciar || recalcular)) await reiniciarProgreso(prisma, objetivo, "nomina");
  let borrados = 0;
  if (objetivo && recalcular) {
    const { count } = await prisma.nominaCosto.deleteMany({
      where: { companyId: objetivo, lineaManual: false },
    });
    borrados = count;
  }

  const where = {
    tipo: "NOMINA" as const,
    status: { not: "CANCELLED" as const },
    rawXml: { not: null },
    nominaCosto: null,
    company: { modules: { some: { modulo: "AUTOMOTRIZ" as ModuloApp, habilitado: true } } },
    ...(objetivo ? { companyId: objetivo } : {}),
  };

  const guardado = objetivo ? await leerProgreso(prisma, objetivo, "nomina") : null;
  let lastId: string | undefined =
    url.searchParams.get("afterId") ?? (guardado && !guardado.completado ? (guardado.cursor ?? undefined) : undefined);
  let barridoCompleto = true;
  let scanned = 0;
  let derivados = 0;

  while (true) {
    if (Date.now() - startedAt >= TIME_BUDGET_MS) {
      barridoCompleto = false;
      break;
    }
    const page = await prisma.invoice.findMany({
      where: { ...where, ...(lastId ? { id: { gt: lastId } } : {}) },
      select: { id: true, companyId: true, tipo: true, fecha: true, rawXml: true, subtotal: true },
      orderBy: { id: "asc" },
      take: PAGE,
    });
    if (page.length === 0) break;

    for (const inv of page) {
      scanned++;
      const creo = await derivarNominaCostoSiAplica(prisma, {
        companyId: inv.companyId,
        invoiceId: inv.id,
        tipo: inv.tipo,
        fecha: inv.fecha,
        rawXml: inv.rawXml,
        subtotal: inv.subtotal,
      });
      if (creo) derivados++;
    }

    lastId = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }

  if (objetivo) {
    await guardarProgreso(prisma, objetivo, "nomina", {
      cursor: lastId ?? null,
      procesados: scanned,
      derivados,
      completado: barridoCompleto,
    });
  }

  const summary = {
    ok: true,
    companyId: objetivo,
    scanned,
    derivados,
    ...(recalcular ? { borrados } : {}),
    completado: barridoCompleto,
    nextAfterId: !barridoCompleto ? (lastId ?? null) : null,
    elapsedMs: Date.now() - startedAt,
  };
  console.log("[cron/nomina-costo-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:nomina-costo-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:nomina-costo-backfill", () => handle(req));
}
