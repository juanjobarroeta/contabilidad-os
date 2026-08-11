import { NextResponse } from "next/server";
import type { ModuloApp } from "@prisma/client";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { derivarServicioDesdeCfdiSiAplica, extraerServicioCfdi } from "@/lib/automotriz/auto-servicio";
import { extraerDatosVehiculoCfdi, tipoComprobanteDesdeCfdi } from "@/lib/automotriz/vin";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/servicio-backfill?companyId=…[&afterId=…]
//
// Drenado histórico de las VENTAS DE SERVICIO/TALLER: recorre los CFDIs de
// ingreso y deriva ServicioVenta (mano de obra vs refacciones, cliente, VIN).
// Cursor afterId → nextAfterId (null = terminó); hacia adelante la derivación
// inline mantiene el histórico al día.
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
  // diagnostico=1: NO escribe nada. Clasifica por qué cada CFDI de la cola no
  // deriva servicio (unidad amparada, nota de crédito, sin línea de servicio…)
  // con ejemplos de UUID por causa. Es la herramienta para cuando el drenado
  // reporta 0 derivadas sobre miles de candidatas: dice dónde se van.
  const diagnostico = url.searchParams.get("diagnostico") === "1";
  const startedAt = Date.now();

  const where = {
    tipo: "INGRESO" as const,
    status: { not: "CANCELLED" as const },
    rawXml: { not: null },
    servicioVenta: null,
    company: { modules: { some: { modulo: "AUTOMOTRIZ" as ModuloApp, habilitado: true } } },
    ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
  };

  let lastId: string | undefined = url.searchParams.get("afterId") ?? undefined;
  let barridoCompleto = true;
  let scanned = 0;
  let derivadas = 0;
  const razones: Record<string, number> = {};
  const ejemplos: Record<string, string[]> = {};

  while (true) {
    if (Date.now() - startedAt >= TIME_BUDGET_MS) {
      barridoCompleto = false;
      break;
    }
    const page = await prisma.invoice.findMany({
      where: { ...where, ...(lastId ? { id: { gt: lastId } } : {}) },
      select: { id: true, companyId: true, tipo: true, fecha: true, total: true, rawXml: true, customerId: true, uuid: true },
      orderBy: { id: "asc" },
      take: PAGE,
    });
    if (page.length === 0) break;

    for (const inv of page) {
      scanned++;
      if (diagnostico) {
        clasificar(inv.rawXml, inv.uuid ?? inv.id, razones, ejemplos);
        continue;
      }
      const creo = await derivarServicioDesdeCfdiSiAplica(prisma, {
        companyId: inv.companyId,
        invoiceId: inv.id,
        tipo: inv.tipo,
        fecha: inv.fecha,
        total: inv.total,
        rawXml: inv.rawXml,
        clienteId: inv.customerId,
      });
      if (creo) derivadas++;
    }

    lastId = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }

  const summary = {
    ok: true,
    scanned,
    derivadas,
    ...(diagnostico ? { diagnostico: true, razones, ejemplos } : {}),
    nextAfterId: !barridoCompleto ? (lastId ?? null) : null,
    elapsedMs: Date.now() - startedAt,
  };
  console.log("[cron/servicio-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

/** Clasifica por qué un CFDI de la cola no deriva servicio (sólo diagnóstico). */
function clasificar(
  rawXml: string | null,
  ref: string,
  razones: Record<string, number>,
  ejemplos: Record<string, string[]>
): void {
  const marcar = (razon: string) => {
    razones[razon] = (razones[razon] ?? 0) + 1;
    const lista = (ejemplos[razon] ??= []);
    if (lista.length < 3) lista.push(ref);
  };
  if (!rawXml) return marcar("sinRawXml");
  if (tipoComprobanteDesdeCfdi(rawXml) === "E") return marcar("notaCredito");
  const unidades = extraerDatosVehiculoCfdi(rawXml).vehiculos.length;
  if (unidades > 0) return marcar("amparaUnidad");
  const datos = extraerServicioCfdi(rawXml);
  if (!datos.esServicio) {
    return marcar(datos.refacciones > 0 ? "soloRefacciones" : "sinLineaDeServicio");
  }
  marcar("derivable");
}

export async function POST(req: Request) {
  return withCronLock("cron:servicio-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:servicio-backfill", () => handle(req));
}
