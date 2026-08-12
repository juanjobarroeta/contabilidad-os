import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { parseCfdiXml } from "@/lib/sat-fiel";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/invoice-contraparte-backfill   [?limit=N]
//
// Rellena Invoice.contraparteNombre/contraparteRfc de los CFDIs importados
// ANTES de que se guardara la contraparte. El nombre siempre estuvo en el XML
// (cfdi:Receptor/@Nombre al emitir, cfdi:Emisor/@Nombre al recibir) pero sólo
// se conservaba al crear un Customer — y a público en general (XAXX010101000) y
// extranjeros (XEXX010101000) no se les crea uno a propósito, así que la lista
// de comprobantes mostraba "—" en facturas que sí traen nombre.
//
// Puramente local: parsea el rawXml ya almacenado, sin viaje al SAT ni costo.
// Complementa al sat-rawxml-backfill: conforme aquél llena rawXml, éste llena
// la contraparte.
//
// Gap-driven e idempotente: sólo toca filas con rawXml y sin contraparteNombre.
// `restantes` converge al número de CFDIs cuyo XML no trae nombre de
// contraparte (raro pero legal) — un restante estable distinto de cero es
// esperado y correcto.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
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
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 5000) : 2000;
  const startedAt = Date.now();

  let actualizadas = 0;
  let sinNombre = 0;
  let procesadas = 0;
  // Cursor por id: las filas ya resueltas salen del filtro, así que paginar por
  // id evita re-leer las que quedaron sin nombre (y que seguirán sin él).
  let cursorId: string | null = null;

  while (procesadas < limit && Date.now() - startedAt < TIME_BUDGET_MS) {
    const where: Prisma.InvoiceWhereInput = {
      contraparteNombre: null,
      rawXml: { not: null },
      ...(cursorId ? { id: { gt: cursorId } } : {}),
    };
    const lote = await prisma.invoice.findMany({
      where,
      select: { id: true, rawXml: true, companyId: true, company: { select: { rfc: true } } },
      orderBy: { id: "asc" },
      take: Math.min(PAGE, limit - procesadas),
    });
    if (lote.length === 0) break;
    cursorId = lote[lote.length - 1].id;

    for (const inv of lote) {
      procesadas++;
      let cfdi;
      try {
        cfdi = parseCfdiXml(inv.rawXml as string);
      } catch {
        sinNombre++;
        continue;
      }
      if (!cfdi) {
        sinNombre++;
        continue;
      }
      // La contraparte depende del lado: receptor si la empresa emitió.
      const esEmisor = cfdi.rfcEmisor === inv.company.rfc;
      const nombre = esEmisor ? cfdi.nombreReceptor : cfdi.nombreEmisor;
      const rfc = esEmisor ? cfdi.rfcReceptor : cfdi.rfcEmisor;
      if (!nombre && !rfc) {
        sinNombre++;
        continue;
      }
      await prisma.invoice.update({
        where: { id: inv.id },
        data: { contraparteNombre: nombre ?? null, contraparteRfc: rfc ?? null },
      });
      if (nombre) actualizadas++;
      else sinNombre++;
    }
  }

  const restantes = await prisma.invoice.count({
    where: { contraparteNombre: null, rawXml: { not: null } },
  });

  const summary = {
    ok: true,
    procesadas,
    actualizadas,
    sinNombre,
    restantes,
    elapsedMs: Date.now() - startedAt,
    nota: "Re-ejecutable: `restantes` converge a los CFDIs cuyo XML no trae nombre de contraparte.",
  };
  console.log("[cron/invoice-contraparte-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:invoice-contraparte-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:invoice-contraparte-backfill", () => handle(req));
}
