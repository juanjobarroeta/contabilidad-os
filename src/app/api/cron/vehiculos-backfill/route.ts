import { NextResponse } from "next/server";
import type { InvoiceType, ModuloApp } from "@prisma/client";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { derivarVehiculoDesdeCfdiSiAplica } from "@/lib/automotriz/auto-vehiculo";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/vehiculos-backfill
//
// Deriva el inventario de vehículos de los CFDIs ya sincronizados que amparan
// una unidad (complemento VentaVehiculos) y aún no están ligados a un Vehiculo.
// Es el gemelo de activos-backfill: local, sin SAT, idempotente
// (derivarVehiculoDesdeCfdiSiAplica no duplica). Corre tras el sync del SAT para
// que, al subir la e.firma, el inventario aparezca solo.
//
// Sólo empresas con el módulo AUTOMOTRIZ habilitado.
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
  // deep=1: pasada completa — sin el prefiltro del complemento (captura CFDIs
  // que sólo traen el VIN en la descripción) y SIN excluir facturas ya ligadas,
  // para que el derivador enriquezca unidades a las que les faltó cliente o
  // proveedor en la primera pasada. Es más caro (rescanea todo) — pensado como
  // corrida manual por empresa, no como cron periódico.
  const deep = url.searchParams.get("deep") === "1";
  const startedAt = Date.now();

  const comun = {
    tipo: { in: ["INGRESO", "EGRESO"] as InvoiceType[] },
    company: { modules: { some: { modulo: "AUTOMOTRIZ" as ModuloApp, habilitado: true } } },
    ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
  };
  // CFDIs que amparan un vehículo, aún sin ligar a un Vehiculo. `rawXml
  // contains` es un prefiltro barato; el parser confirma el complemento.
  const wherePendientes = {
    ...comun,
    rawXml: { contains: "VentaVehiculos" },
    vehiculosComprados: { none: {} },
    vehiculosVendidos: { none: {} },
  };
  const where = deep ? { ...comun, rawXml: { not: null } } : wherePendientes;

  let lastId: string | undefined;
  let scanned = 0;
  let creados = 0;
  let actualizados = 0;

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const page = await prisma.invoice.findMany({
      where: { ...where, ...(lastId ? { id: { gt: lastId } } : {}) },
      select: {
        id: true, companyId: true, tipo: true, fecha: true, rawXml: true, customerId: true,
      },
      orderBy: { id: "asc" },
      take: PAGE,
    });
    if (page.length === 0) break;

    for (const inv of page) {
      scanned++;
      const r = await derivarVehiculoDesdeCfdiSiAplica(prisma, {
        companyId: inv.companyId,
        invoiceId: inv.id,
        tipo: inv.tipo,
        fecha: inv.fecha,
        rawXml: inv.rawXml,
        // En una venta el receptor canónico es el cliente. El proveedor de una
        // compra (emisor) se resuelve en una enriquecedora posterior.
        clienteId: inv.tipo === "INGRESO" ? inv.customerId : null,
      });
      if (r) {
        creados += r.creados;
        actualizados += r.actualizados;
      }
    }

    lastId = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }

  // `remaining` siempre mide la cola normal (con prefiltro), que es la métrica
  // de convergencia; en deep el universo escaneado no converge a cero.
  const remaining = await prisma.invoice.count({ where: wherePendientes });
  const summary = { ok: true, deep, scanned, creados, actualizados, remaining, elapsedMs: Date.now() - startedAt };
  console.log("[cron/vehiculos-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:vehiculos-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:vehiculos-backfill", () => handle(req));
}
