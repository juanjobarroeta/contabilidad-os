import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { clasificarCfdi } from "@/lib/fiscal/clasificar-cfdi";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/naturaleza-backfill
//
// Clasifica la naturaleza fiscal (GASTO/INVERSION/INVENTARIO/SIN_EFECTOS) de los
// EGRESO existentes que aún no la tienen, a partir de su usoCfdi + claves de
// producto. Puramente local (sin SAT). Respeta las clasificaciones manuales del
// contador (naturalezaManual). Seguro de re-ejecutar.
//
// NO modifica el cálculo de impuestos — sólo rellena el dato para el motor de
// deducibilidad (depreciación / costo de lo vendido) que se construye encima.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGE = 300;
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
  const startedAt = Date.now();

  // EGRESO sin naturaleza y no fijados a mano. (Los INGRESO/NOMINA/PAGO no se
  // clasifican para deducibilidad.)
  const where = {
    tipo: "EGRESO" as const,
    naturaleza: null,
    naturalezaManual: false,
    ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
  };

  let lastId: string | undefined;
  let scanned = 0;
  let classified = 0;
  let flagged = 0;
  const counts: Record<string, number> = {};

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const page = await prisma.invoice.findMany({
      where: { ...where, ...(lastId ? { id: { gt: lastId } } : {}) },
      select: {
        id: true,
        tipo: true,
        usoCfdi: true,
        items: { select: { claveProdServ: true, importe: true } },
      },
      orderBy: { id: "asc" },
      take: PAGE,
    });
    if (page.length === 0) break;

    for (const inv of page) {
      scanned++;
      const clasif = clasificarCfdi({
        tipo: inv.tipo,
        usoCfdi: inv.usoCfdi ?? null,
        // No sabemos si el usoCfdi guardado fue default; G01/I0x/S01 son
        // explícitos de todos modos, y un G03 con clave de activo se marca.
        usoEsDefault: false,
        items: inv.items.map((it) => ({ claveProdServ: it.claveProdServ, importe: it.importe })),
      });
      if (clasif.fuente === "no_aplica") continue;
      await prisma.invoice.update({
        where: { id: inv.id },
        data: { naturaleza: clasif.naturaleza, naturalezaRevision: clasif.requiereRevision },
      });
      classified++;
      if (clasif.requiereRevision) flagged++;
      counts[clasif.naturaleza] = (counts[clasif.naturaleza] ?? 0) + 1;
    }

    lastId = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }

  const remaining = await prisma.invoice.count({ where });

  const summary = {
    ok: true,
    scanned,
    classified,
    flaggedForReview: flagged,
    porNaturaleza: counts,
    remaining,
    elapsedMs: Date.now() - startedAt,
  };
  console.log("[cron/naturaleza-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
