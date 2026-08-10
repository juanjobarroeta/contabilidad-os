import { NextResponse } from "next/server";
import type { InvoiceType, ModuloApp } from "@prisma/client";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { derivarVehiculoDesdeCfdiSiAplica } from "@/lib/automotriz/auto-vehiculo";
import { emisorDesdeCfdi } from "@/lib/automotriz/vin";

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
    // Un CFDI cancelado no mueve inventario (una venta cancelada y refacturada
    // ligaría la unidad a la factura muerta) y tampoco debe contar en la cola.
    status: { not: "CANCELLED" as const },
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

  // Cursor para la pasada profunda: escanea TODO el universo, así que una sola
  // corrida (4 min) no alcanza. `afterId` continúa donde quedó la anterior; la
  // respuesta trae `nextAfterId` (null = el barrido llegó al final).
  let lastId: string | undefined = url.searchParams.get("afterId") ?? undefined;
  let barridoCompleto = true;
  let scanned = 0;
  let creados = 0;
  let actualizados = 0;
  // Cache por corrida: (companyId|rfc emisor) → Supplier.id. El resolver es
  // perezoso — el derivador sólo lo invoca cuando de verdad liga una compra.
  const supplierCache = new Map<string, string>();
  const resolverSupplier = (companyId: string, rawXml: string) => async () => {
    const emisor = emisorDesdeCfdi(rawXml);
    if (!emisor) return null;
    const key = `${companyId}|${emisor.rfc}`;
    const cached = supplierCache.get(key);
    if (cached) return cached;
    const s = await prisma.supplier.upsert({
      where: { companyId_rfc: { companyId, rfc: emisor.rfc } },
      create: { companyId, rfc: emisor.rfc, razonSocial: emisor.nombre ?? emisor.rfc },
      update: {},
      select: { id: true },
    });
    supplierCache.set(key, s.id);
    return s.id;
  };

  while (true) {
    if (Date.now() - startedAt >= TIME_BUDGET_MS) {
      barridoCompleto = false;
      break;
    }
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
        // En una venta el receptor canónico es el cliente; en una compra, el
        // emisor se resuelve (find-or-create por RFC) sólo si liga una unidad.
        clienteId: inv.tipo === "INGRESO" ? inv.customerId : null,
        resolverSupplierId:
          inv.tipo === "EGRESO" && inv.rawXml ? resolverSupplier(inv.companyId, inv.rawXml) : undefined,
      });
      if (r) {
        creados += r.creados;
        actualizados += r.actualizados;
      }
    }

    lastId = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }

  // `remaining` mide TRABAJO REAL pendiente: CFDIs de la cola cuyo VIN es
  // válido (ISO 3779) y aún no existe como unidad. Los que jamás podrán
  // ligarse se reportan aparte — `duplicados` (el VIN ya está ligado a OTRA
  // factura: refacturación sin cancelar, doble facturación) y `nivInvalido`
  // (caracteres I/O/Q o basura) — para que remaining=0 signifique "no hay
  // nada pendiente de verdad". Aproximación por el primer Niv del CFDI.
  const [detalle] = await prisma.$queryRaw<
    Array<{ pendientes: bigint; duplicados: bigint; niv_invalido: bigint }>
  >`
    SELECT
      count(*) FILTER (
        WHERE t.niv ~ '^[A-HJ-NPR-Z0-9]{17}$'
          AND NOT EXISTS (SELECT 1 FROM "Vehiculo" v WHERE v."companyId" = t."companyId" AND v."vin" = t.niv)
      ) AS pendientes,
      count(*) FILTER (
        WHERE t.niv ~ '^[A-HJ-NPR-Z0-9]{17}$'
          AND EXISTS (SELECT 1 FROM "Vehiculo" v WHERE v."companyId" = t."companyId" AND v."vin" = t.niv)
      ) AS duplicados,
      count(*) FILTER (WHERE t.niv IS NULL OR t.niv !~ '^[A-HJ-NPR-Z0-9]{17}$') AS niv_invalido
    FROM (
      SELECT i.id, i."companyId", upper(substring(i."rawXml" from 'Niv="([^"]*)"')) AS niv
      FROM "Invoice" i
      WHERE i."tipo" IN ('INGRESO', 'EGRESO')
        AND i."status" <> 'CANCELLED'
        AND i."rawXml" LIKE '%VentaVehiculos%'
        AND EXISTS (
          SELECT 1 FROM "CompanyModule" m
          WHERE m."companyId" = i."companyId" AND m."modulo" = 'AUTOMOTRIZ' AND m."habilitado"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "Vehiculo" v WHERE v."compraInvoiceId" = i.id OR v."ventaInvoiceId" = i.id
        )
        AND (${onlyCompanyId}::text IS NULL OR i."companyId" = ${onlyCompanyId})
    ) t`;
  const remaining = Number(detalle?.pendientes ?? 0);
  const remainingDetalle = {
    duplicados: Number(detalle?.duplicados ?? 0),
    nivInvalido: Number(detalle?.niv_invalido ?? 0),
  };
  const summary = {
    ok: true,
    deep,
    limpieza,
    scanned,
    creados,
    actualizados,
    remaining,
    remainingDetalle,
    // Sólo relevante en deep: pásalo como ?afterId=… en la siguiente llamada
    // para continuar el barrido. null = ya recorrió todo el universo.
    nextAfterId: deep && !barridoCompleto ? (lastId ?? null) : null,
    elapsedMs: Date.now() - startedAt,
  };
  console.log("[cron/vehiculos-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

/**
 * Deshace las derivaciones fantasma de una empresa. Un CFDI es "fantasma" si
 * NO trae el complemento VentaVehiculos NI ningún concepto con clave de
 * vehículo (2510xx) — el mismo candado del extractor. La exención 2510 importa:
 * sin ella, esta limpieza desharía las compras legítimas sin complemento que
 * el derivador acaba de crear y cada ciclo limpieza+deep se pelearía con el
 * anterior (churn). Sólo toca unidades `autoCreado` — nada capturado a mano.
 */
async function limpiarFantasmas(companyId: string) {
  // 1) Ventas ligadas a un CFDI que no ampara unidad → deshacer la venta.
  const ventas = await prisma.$executeRaw`
    UPDATE "Vehiculo" v
    SET "estado" = 'DISPONIBLE', "ventaInvoiceId" = NULL, "precioVenta" = NULL,
        "fechaVenta" = NULL, "clienteId" = NULL
    FROM "Invoice" i
    WHERE i.id = v."ventaInvoiceId" AND v."companyId" = ${companyId}
      AND v."autoCreado"
      AND (i."status" = 'CANCELLED'
           OR (i."rawXml" IS NOT NULL
               AND i."rawXml" NOT LIKE '%VentaVehiculos%'
               AND i."rawXml" NOT LIKE '%ClaveProdServ="2510%'))`;

  // 2) Costos fantasma: sólo los que el derivador VIEJO pegó desde la propia
  //    factura de compra fantasma (c.invoiceId = compraInvoiceId). Los costos
  //    por nivRef (flete/seguro facturado aparte) viven en OTRA factura y son
  //    legítimos — no se tocan.
  const costos = await prisma.$executeRaw`
    DELETE FROM "VehiculoCosto" c
    USING "Invoice" i, "Vehiculo" v
    WHERE c."invoiceId" = i.id AND c."vehiculoId" = v.id
      AND c."invoiceId" = v."compraInvoiceId"
      AND v."companyId" = ${companyId} AND v."autoCreado"
      AND (i."status" = 'CANCELLED'
           OR (i."rawXml" IS NOT NULL
               AND i."rawXml" NOT LIKE '%VentaVehiculos%'
               AND i."rawXml" NOT LIKE '%ClaveProdServ="2510%'))`;

  // 3) Compras fantasma en unidades vendidas de verdad → sólo desligar la compra.
  const compras = await prisma.$executeRaw`
    UPDATE "Vehiculo" v
    SET "compraInvoiceId" = NULL, "costoCompra" = 0, "fechaCompra" = NULL, "supplierId" = NULL
    FROM "Invoice" i
    WHERE i.id = v."compraInvoiceId" AND v."companyId" = ${companyId}
      AND v."autoCreado"
      AND (i."status" = 'CANCELLED'
           OR (i."rawXml" IS NOT NULL
               AND i."rawXml" NOT LIKE '%VentaVehiculos%'
               AND i."rawXml" NOT LIKE '%ClaveProdServ="2510%'))
      AND v."ventaInvoiceId" IS NOT NULL`;

  // 4) Costos residuales de las unidades que van a borrarse en 5) y 6).
  await prisma.$executeRaw`
    DELETE FROM "VehiculoCosto" c
    USING "Vehiculo" v
    LEFT JOIN "Invoice" i ON i.id = v."compraInvoiceId"
    WHERE c."vehiculoId" = v.id AND v."companyId" = ${companyId}
      AND v."autoCreado" AND v."ventaInvoiceId" IS NULL
      AND (v."compraInvoiceId" IS NULL
           OR i."status" = 'CANCELLED'
           OR (i."rawXml" IS NOT NULL
               AND i."rawXml" NOT LIKE '%VentaVehiculos%'
               AND i."rawXml" NOT LIKE '%ClaveProdServ="2510%'))`;

  // 5) Unidades fantasma no vendidas cuya "compra" no ampara vehículo.
  const unidades = await prisma.$executeRaw`
    DELETE FROM "Vehiculo" v
    USING "Invoice" i
    WHERE i.id = v."compraInvoiceId" AND v."companyId" = ${companyId}
      AND v."autoCreado"
      AND (i."status" = 'CANCELLED'
           OR (i."rawXml" IS NOT NULL
               AND i."rawXml" NOT LIKE '%VentaVehiculos%'
               AND i."rawXml" NOT LIKE '%ClaveProdServ="2510%'))
      AND v."ventaInvoiceId" IS NULL`;

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
