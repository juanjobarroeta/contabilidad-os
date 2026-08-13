import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { parseCfdiXml } from "@/lib/sat-fiel";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/relaciones-backfill   [?companyId=…&limit=N]
//
// Rellena Invoice.tipoRelacion / cfdiRelacionadoUuid de todo lo que se importó
// antes de que el parser leyera el nodo <cfdi:CfdiRelacionados>.
//
// El agujero: hasta ahora la ÚNICA escritura de esas dos columnas estaba en el
// módulo que EMITE notas de crédito desde la app. Todo lo descargado del SAT
// las tenía en null — 27,336 facturas de ingreso de Margom, con 6,129 notas de
// crédito y 5,052 anticipos entre ellas. Cualquier regla que dependiera de la
// relación (qué nota corrige a qué factura, qué CFDI aplica un anticipo)
// quedaba inerte, y el neteo se tenía que adivinar por importe y fecha.
//
// Puramente local: parsea el rawXml ya almacenado, sin viaje al SAT ni costo.
//
// Gap-driven e idempotente. El filtro pide las dos cosas a la vez:
//   • tipoRelacion: null       → todavía no se le llenó
//   • rawXml contains "CfdiRelacionados" → el comprobante SÍ trae relación
// La segunda condición es la que hace esto barato: la enorme mayoría de los
// CFDIs no tiene relación alguna, y así ni se leen. `restantes` converge a 0.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGE = 500;
const TIME_BUDGET_MS = 240_000;
const DEFAULT_LIMIT = 20_000;
const MAX_LIMIT = 200_000;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const onlyCompanyId = url.searchParams.get("companyId");
  const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(limitParam, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const startedAt = Date.now();

  const base: Prisma.InvoiceWhereInput = {
    tipoRelacion: null,
    // El nodo se llama igual con cualquier prefijo de namespace (cfdi:, cfdi4:),
    // así que la subcadena basta y se resuelve en el motor, no en Node.
    rawXml: { contains: "CfdiRelacionados" },
    ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
  };

  let procesadas = 0;
  let actualizadas = 0;
  let sinRelacionUtil = 0;
  // Cuántas de cada tipo se encontraron — 01 nota de crédito, 04 sustitución,
  // 07 aplicación de anticipo. Es el dato que se está persiguiendo.
  const porTipo = new Map<string, number>();
  let cursorId: string | null = null;

  while (procesadas < limit && Date.now() - startedAt < TIME_BUDGET_MS) {
    const where: Prisma.InvoiceWhereInput = {
      ...base,
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
      // MARCA DE INTENTO. El filtro de arriba exige tipoRelacion null, así que
      // una fila cuyo XML traiga el nodo pero no rinda un par (tipo, uuid)
      // usable volvería a entrar en cada corrida y el barrido giraría sobre
      // ella para siempre. Cadena vacía = "ya se intentó, no lo trae".
      const marcarIntentado = () =>
        prisma.invoice.update({ where: { id: inv.id }, data: { tipoRelacion: "" } });

      let rel: Array<{ tipoRelacion: string; uuids: string[] }>;
      try {
        rel = parseCfdiXml(inv.rawXml as string).relacionados;
      } catch {
        sinRelacionUtil++;
        await marcarIntentado();
        continue;
      }
      const primera = rel[0];
      if (!primera || !primera.uuids[0]) {
        sinRelacionUtil++;
        await marcarIntentado();
        continue;
      }
      await prisma.invoice.update({
        where: { id: inv.id },
        data: {
          tipoRelacion: primera.tipoRelacion,
          cfdiRelacionadoUuid: primera.uuids[0],
        },
      });
      actualizadas++;
      porTipo.set(primera.tipoRelacion, (porTipo.get(primera.tipoRelacion) ?? 0) + 1);
    }
  }

  const restantes = await prisma.invoice.count({ where: base });

  const summary = {
    ok: true,
    procesadas,
    actualizadas,
    sinRelacionUtil,
    restantes,
    porTipo: [...porTipo.entries()]
      .map(([tipoRelacion, facturas]) => ({ tipoRelacion, facturas }))
      .sort((a, b) => b.facturas - a.facturas),
    elapsedMs: Date.now() - startedAt,
    nota: "Re-ejecutable: `restantes` converge a 0. Sólo lee CFDIs que traen el nodo CfdiRelacionados.",
  };
  console.log("[cron/relaciones-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:relaciones-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:relaciones-backfill", () => handle(req));
}
