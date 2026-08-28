import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automotriz/refacciones/wip — refacciones EN ÓRDENES: salieron del
// almacén a una orden de servicio abierta y todavía no se facturan.
//
// Dos lados del mismo número:
//   DERIVADO   — Σ líneas REFACCION de órdenes abiertas (RECIBIDA/EN_PROCESO/
//                LISTA), a COSTO con la regla de comparabilidad de unidades
//                (misma condición que calcularResultados/absorcionPorMes: el
//                tambo comprado por 208L no multiplica litros vendidos).
//   DECLARADO  — la cuenta de inventario «...ORD PROCESO» del catálogo del
//                contador (en MARGOM 1314-0003), localizada POR NOMBRE — no
//                hardcodeada: otra agencia con otro número también la
//                encuentra. Su serie mensual sale de la CE (hoja).
//
// La brecha inicial es de ADOPCIÓN, no de datos: el DMS del taller trae
// órdenes abiertas que aún no viven aquí. Conforme la recepción se opere en
// AutomotrizPro, el derivado converge al declarado.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

// La condición de costo COMPARABLE, en SQL (fijada por absorcion-comparable.test).
const COSTO_COMPARABLE = `
  r."ultimoCosto" > 0 AND (
    COALESCE(r."factorCosto", 0) > 0
    OR (
      (r."unidadCosto" IS NULL OR r."unidadPrecio" IS NULL OR r."unidadCosto" = r."unidadPrecio")
      AND NOT (COALESCE(r."ultimoPrecio", 0) > 0 AND r."ultimoCosto" > COALESCE(r."ultimoPrecio", 0) * 2)
    )
  )`;

// Costo por UNIDAD DE VENTA: con factor guardado, el costo del envase se
// divide (tambo ÷ 208 = litro) — misma doctrina que unidad-refaccion.ts.
const COSTO_VENTA = `
  CASE WHEN COALESCE(r."factorCosto", 0) > 0 THEN r."ultimoCosto" / r."factorCosto"
       ELSE r."ultimoCosto" END`;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  // ── DERIVADO: refacciones a costo en órdenes abiertas ─────────────────────
  const ordenes = await prisma.$queryRawUnsafe<
    {
      id: string; folio: number; estado: string; recibidaAt: Date;
      cliente: string | null; unidad: string | null;
      lineas: number; costo: number; venta: number; sin_costo: number;
    }[]
  >(
    `SELECT o.id, o.folio, o.estado::text AS estado, o."recibidaAt",
       c."razonSocial" AS cliente,
       COALESCE(o."descripcionUnidad", NULLIF(TRIM(CONCAT(v.marca, ' ', v.modelo, ' ', v.anio)), '')) AS unidad,
       COUNT(l.id)::int AS lineas,
       COALESCE(SUM(CASE WHEN ${COSTO_COMPARABLE} THEN l.cantidad * (${COSTO_VENTA}) ELSE 0 END), 0)::float8 AS costo,
       COALESCE(SUM(l.cantidad * l."precioUnitario"), 0)::float8 AS venta,
       COUNT(l.id) FILTER (WHERE r.id IS NULL OR NOT (${COSTO_COMPARABLE}))::int AS sin_costo
     FROM "OrdenServicio" o
     JOIN "OrdenServicioLinea" l ON l."ordenId" = o.id AND l.tipo = 'REFACCION'
     LEFT JOIN "Refaccion" r ON r.id = l."refaccionId"
     LEFT JOIN "Customer" c ON c.id = o."clienteId"
     LEFT JOIN "Vehiculo" v ON v.id = o."vehiculoId"
     WHERE o."companyId" = $1 AND o.estado IN ('RECIBIDA', 'EN_PROCESO', 'LISTA')
     GROUP BY o.id, o.folio, o.estado, o."recibidaAt", c."razonSocial", v.marca, v.modelo, v.anio
     ORDER BY o."recibidaAt" ASC
     LIMIT 200`,
    companyId
  );

  const derivado = {
    total: r2(ordenes.reduce((a, o) => a + o.costo, 0)),
    ventaTotal: r2(ordenes.reduce((a, o) => a + o.venta, 0)),
    lineasSinCosto: ordenes.reduce((a, o) => a + o.sin_costo, 0),
    ordenes: ordenes.map((o) => ({
      id: o.id, folio: o.folio, estado: o.estado, recibidaAt: o.recibidaAt,
      cliente: o.cliente, unidad: o.unidad,
      lineas: o.lineas, costo: r2(o.costo), venta: r2(o.venta), sinCosto: o.sin_costo,
    })),
  };

  // ── DECLARADO: la cuenta WIP del catálogo, localizada por nombre ──────────
  const wipCta = await prisma.chartAccount.findFirst({
    where: {
      companyId,
      cuentaSAT: { startsWith: "13" },
      nombre: { contains: "PROCESO", mode: "insensitive" },
    },
    select: { cuentaSAT: true, nombre: true },
  });

  let declarado: null | {
    cuenta: string; nombre: string;
    saldo: number; corte: { anio: number; mes: number };
    serie: { anio: number; mes: number; saldoFin: number; debe: number; haber: number }[];
    almacen: { cuenta: string; nombre: string; saldo: number } | null;
    mostrador: { anio: number; salidasAlmacen: number; aOrdenes: number; directo: number } | null;
  } = null;

  if (wipCta) {
    const familia = wipCta.cuentaSAT.slice(0, 4);
    const almacenCta = await prisma.chartAccount.findFirst({
      where: {
        companyId,
        cuentaSAT: { startsWith: familia },
        nombre: { contains: "ALM", mode: "insensitive" },
      },
      select: { cuentaSAT: true, nombre: true },
    });

    const serie = await prisma.$queryRawUnsafe<
      { anio: number; mes: number; saldoFin: number; debe: number; haber: number }[]
    >(
      `SELECT anio, mes, "saldoFin"::float8 AS "saldoFin", debe::float8 AS debe, haber::float8 AS haber
       FROM "CeBalanzaMes"
       WHERE "companyId" = $1 AND "numCta" = $2 AND "esPadre" = false
       ORDER BY anio DESC, mes DESC LIMIT 13`,
      companyId, wipCta.cuentaSAT
    );

    if (serie.length) {
      const ultimo = serie[0];
      // Contexto mostrador vs taller del año del corte: lo que el almacén
      // descarga (haber) menos lo que entra a órdenes (debe WIP) ≈ venta
      // directa de ventanilla.
      let mostrador: { anio: number; salidasAlmacen: number; aOrdenes: number; directo: number } | null = null;
      let almacen: { cuenta: string; nombre: string; saldo: number } | null = null;
      if (almacenCta) {
        const alm = await prisma.$queryRawUnsafe<
          { haber_alm: number; debe_wip: number; saldo_alm: number }[]
        >(
          `SELECT
             COALESCE(SUM(CASE WHEN "numCta" = $2 THEN haber END), 0)::float8 AS haber_alm,
             COALESCE(SUM(CASE WHEN "numCta" = $3 THEN debe END), 0)::float8 AS debe_wip,
             COALESCE(MAX(CASE WHEN "numCta" = $2 AND anio = $4 AND mes = $5 THEN "saldoFin" END), 0)::float8 AS saldo_alm
           FROM "CeBalanzaMes"
           WHERE "companyId" = $1 AND anio = $4 AND "esPadre" = false AND "numCta" IN ($2, $3)`,
          companyId, almacenCta.cuentaSAT, wipCta.cuentaSAT, ultimo.anio, ultimo.mes
        );
        const a = alm[0];
        almacen = { cuenta: almacenCta.cuentaSAT, nombre: almacenCta.nombre, saldo: r2(a?.saldo_alm ?? 0) };
        mostrador = {
          anio: ultimo.anio,
          salidasAlmacen: r2(a?.haber_alm ?? 0),
          aOrdenes: r2(a?.debe_wip ?? 0),
          directo: r2((a?.haber_alm ?? 0) - (a?.debe_wip ?? 0)),
        };
      }
      declarado = {
        cuenta: wipCta.cuentaSAT,
        nombre: wipCta.nombre,
        saldo: r2(ultimo.saldoFin),
        corte: { anio: ultimo.anio, mes: ultimo.mes },
        serie: serie.slice().reverse().map((s) => ({
          anio: s.anio, mes: s.mes, saldoFin: r2(s.saldoFin), debe: r2(s.debe), haber: r2(s.haber),
        })),
        almacen,
        mostrador,
      };
    }
  }

  return NextResponse.json({
    derivado,
    declarado,
    reconciliacion: declarado
      ? {
          derivado: derivado.total,
          declarado: declarado.saldo,
          cobertura: declarado.saldo > 0 ? r2(derivado.total / declarado.saldo) : null,
          // La brecha temprana es adopción: el DMS trae órdenes abiertas que
          // aún no se capturan aquí. El número derivado crece con cada
          // recepción operada en la app.
          adopcion: derivado.total < declarado.saldo * 0.5,
        }
      : null,
  });
});
