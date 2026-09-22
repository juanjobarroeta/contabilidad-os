import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { parseCfdiXml } from "@/lib/sat-fiel";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/invoice-descuento-backfill   [?limit=N][&companyId=]
//
// Rellena Invoice.descuento desde el rawXml ya guardado. parseCfdiXml no leía
// el atributo Descuento del Comprobante hasta el 22-sep-2026: 43,455 CFDIs con
// descuento en el XML tenían 0 en la fila (visto al cotejar el acuse de
// agosto de una empresa: el SAT reportaba 39,846 de descuentos en facturas
// PUE y nosotros nada). No cambia el ISR provisional (ingresos nominales =
// subtotal bruto, Art. 14 LISR) ni el IVA (viene de InvoiceTax): es el dato
// de la factura el que estaba mal.
//
// Puramente local (parse del rawXml + UPDATE), gap-driven e idempotente: sólo
// toca filas con `Descuento="` en el XML y descuento = 0; una vez corregida,
// sale del filtro. `restantes` converge a los XML cuyo Descuento es 0.00.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGE = 500;
const TIME_BUDGET_MS = 240_000;
const DEFAULT_LIMIT = 20_000;
const MAX_LIMIT = 100_000;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const onlyCompanyId = url.searchParams.get("companyId");
  const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const startedAt = Date.now();

  let procesadas = 0;
  let actualizadas = 0;
  let sinDescuento = 0;
  let cursorId: string | null = null;

  while (procesadas < limit && Date.now() - startedAt < TIME_BUDGET_MS) {
    const where: Prisma.InvoiceWhereInput = {
      descuento: 0,
      rawXml: { contains: 'Descuento="' },
      ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
      ...(cursorId ? { id: { gt: cursorId } } : {}),
    };
    const lote = await prisma.invoice.findMany({
      where,
      select: { id: true, rawXml: true },
      orderBy: { id: "asc" },
      take: Math.min(PAGE, limit - procesadas),
    });
    if (lote.length === 0) break;
    cursorId = lote[lote.length - 1].id;

    for (const inv of lote) {
      procesadas++;
      let descuento = 0;
      try {
        descuento = parseCfdiXml(inv.rawXml as string)?.descuento ?? 0;
      } catch {
        descuento = 0;
      }
      // Descuento="0.00" (o ilegible): no hay nada que corregir; el cursor por
      // id garantiza que no se vuelve a leer en esta corrida.
      if (!(descuento > 0)) {
        sinDescuento++;
        continue;
      }
      await prisma.invoice.update({ where: { id: inv.id }, data: { descuento } });
      actualizadas++;
    }
  }

  const restantes = await prisma.invoice.count({
    where: {
      descuento: 0,
      rawXml: { contains: 'Descuento="' },
      ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
    },
  });

  const summary = {
    ok: true,
    procesadas,
    actualizadas,
    sinDescuento,
    restantes,
    elapsedMs: Date.now() - startedAt,
    nota: "Re-ejecutable: `restantes` converge a los CFDIs cuyo XML trae Descuento=\"0.00\".",
  };
  console.log("[cron/invoice-descuento-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:invoice-descuento-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:invoice-descuento-backfill", () => handle(req));
}
