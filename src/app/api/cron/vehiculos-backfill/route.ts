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
  // cleanup=1 (requiere companyId): deshace las derivaciones fantasma que dejó
  // la pasada profunda ANTES del candado "un concepto con VIN sólo es unidad
  // con complemento o clave 2510xx" — ventas/compras ligadas a CFDIs que no
  // amparan una unidad. Idempotente; correr junto con deep=1 re-deriva bien
  // (compras reales sin complemento, fletes como costos, renombres).
  const cleanup = url.searchParams.get("cleanup") === "1";
  if (cleanup && !onlyCompanyId) {
    return NextResponse.json({ error: "cleanup=1 requiere companyId" }, { status: 400 });
  }
  const startedAt = Date.now();
  const limpieza = cleanup && onlyCompanyId ? await limpiarFantasmas(onlyCompanyId) : null;

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
  const summary = { ok: true, deep, limpieza, scanned, creados, actualizados, remaining, elapsedMs: Date.now() - startedAt };
  console.log("[cron/vehiculos-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

/**
 * Deshace las derivaciones fantasma de una empresa. Los mismos seis pasos del
 * script de limpieza, en SQL parametrizado (el editor de Railway no digiere
 * subqueries). Sólo toca unidades `autoCreado` y CFDIs con rawXml del SAT que
 * NO traen el complemento — nada capturado a mano.
 */
async function limpiarFantasmas(companyId: string) {
  // 1) Ventas ligadas a un CFDI que no ampara unidad → deshacer la venta.
  const ventas = await prisma.$executeRaw`
    UPDATE "Vehiculo" v
    SET "estado" = 'DISPONIBLE', "ventaInvoiceId" = NULL, "precioVenta" = NULL,
        "fechaVenta" = NULL, "clienteId" = NULL
    FROM "Invoice" i
    WHERE i.id = v."ventaInvoiceId" AND v."companyId" = ${companyId}
      AND v."autoCreado" AND i."rawXml" IS NOT NULL
      AND i."rawXml" NOT LIKE '%VentaVehiculos%'`;

  // 2) Costos derivados de CFDIs sin complemento (la re-corrida los re-atribuye).
  const costos = await prisma.$executeRaw`
    DELETE FROM "VehiculoCosto" c
    USING "Invoice" i, "Vehiculo" v
    WHERE c."invoiceId" = i.id AND c."vehiculoId" = v.id
      AND v."companyId" = ${companyId}
      AND i."rawXml" IS NOT NULL AND i."rawXml" NOT LIKE '%VentaVehiculos%'`;

  // 3) Compras fantasma en unidades vendidas de verdad → sólo desligar la compra.
  const compras = await prisma.$executeRaw`
    UPDATE "Vehiculo" v
    SET "compraInvoiceId" = NULL, "costoCompra" = 0, "fechaCompra" = NULL, "supplierId" = NULL
    FROM "Invoice" i
    WHERE i.id = v."compraInvoiceId" AND v."companyId" = ${companyId}
      AND v."autoCreado" AND i."rawXml" IS NOT NULL
      AND i."rawXml" NOT LIKE '%VentaVehiculos%' AND v."ventaInvoiceId" IS NOT NULL`;

  // 4) Costos residuales de las unidades que van a borrarse en 5) y 6).
  await prisma.$executeRaw`
    DELETE FROM "VehiculoCosto" c
    USING "Vehiculo" v
    LEFT JOIN "Invoice" i ON i.id = v."compraInvoiceId"
    WHERE c."vehiculoId" = v.id AND v."companyId" = ${companyId}
      AND v."autoCreado" AND v."ventaInvoiceId" IS NULL
      AND (v."compraInvoiceId" IS NULL
           OR (i."rawXml" IS NOT NULL AND i."rawXml" NOT LIKE '%VentaVehiculos%'))`;

  // 5) Unidades fantasma no vendidas cuya "compra" no trae complemento.
  const unidades = await prisma.$executeRaw`
    DELETE FROM "Vehiculo" v
    USING "Invoice" i
    WHERE i.id = v."compraInvoiceId" AND v."companyId" = ${companyId}
      AND v."autoCreado" AND i."rawXml" IS NOT NULL
      AND i."rawXml" NOT LIKE '%VentaVehiculos%' AND v."ventaInvoiceId" IS NULL`;

  // 6) Unidades auto-creadas que quedaron sin ningún CFDI (nacieron de una
  //    venta fantasma deshecha en 1).
  const huerfanas = await prisma.$executeRaw`
    DELETE FROM "Vehiculo"
    WHERE "companyId" = ${companyId} AND "autoCreado"
      AND "compraInvoiceId" IS NULL AND "ventaInvoiceId" IS NULL`;

  return { ventasDeshechas: ventas, costosBorrados: costos, comprasDesligadas: compras, unidadesBorradas: unidades + huerfanas };
}

export async function POST(req: Request) {
  return withCronLock("cron:vehiculos-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:vehiculos-backfill", () => handle(req));
}
