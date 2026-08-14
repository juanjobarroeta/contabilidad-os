import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/cron/inventario-cuadre?companyId=<id>[&anio=YYYY]
//
// ¿El inventario que decimos tener es el que dicen los libros?
//
// La balanza de MARGOM suma $147,888,997.17 entre las familias 1301 (nuevos),
// 1302 (demos) y 1312 (usados). El padrón dice $558,533,750.55 en piso. Son
// cuatro veces, y ninguna diferencia de fecha explica eso: sobran unidades que
// seguimos contando en piso.
//
// La sospecha es el espejo del defecto de las unidades sin CFDI de compra: ahí
// faltaba la compra, aquí falta la SALIDA. Una unidad que se vendió pero cuya
// venta nunca empató con el VIN se queda en piso para siempre e infla el
// inventario. Por eso el desglose va por AÑO DE COMPRA: una unidad comprada en
// 2023 que sigue «disponible» no es piso, es un empate que no ocurrió.
//
// Sólo lee. Devuelve conteos e importes agregados de la propia empresa — ni
// VINs, ni clientes, ni proveedores. Auth: CRON_SECRET.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const companyId = params.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  const anio = Number(params.get("anio") ?? new Date().getFullYear());
  if (!Number.isFinite(anio) || anio < 2000 || anio > 2100) {
    return NextResponse.json({ error: "anio inválido" }, { status: 400 });
  }
  const desde = new Date(Date.UTC(anio, 0, 1));
  const hasta = new Date(Date.UTC(anio + 1, 0, 1));

  // ── 1. El padrón por tipo ──────────────────────────────────────────────────
  // «En piso» = sin CFDI de venta ligado. Es exactamente el criterio con el que
  // la pantalla de inventario dice $558,533,750.55.
  const porTipo = await prisma.$queryRaw<
    Array<{
      tipo: string;
      vendidas: bigint;
      precio_venta: number | null;
      costo_vendidas: number | null;
      en_piso: bigint;
      costo_en_piso: number | null;
    }>
  >`
    SELECT v."tipo"::text AS tipo,
      COUNT(*) FILTER (WHERE v."ventaInvoiceId" IS NOT NULL)                       AS vendidas,
      SUM(v."precioVenta") FILTER (WHERE v."ventaInvoiceId" IS NOT NULL)::float8   AS precio_venta,
      SUM(v."costoCompra") FILTER (WHERE v."ventaInvoiceId" IS NOT NULL)::float8   AS costo_vendidas,
      COUNT(*) FILTER (WHERE v."ventaInvoiceId" IS NULL)                           AS en_piso,
      SUM(v."costoCompra") FILTER (WHERE v."ventaInvoiceId" IS NULL)::float8       AS costo_en_piso
    FROM "Vehiculo" v
    WHERE v."companyId" = ${companyId}
    GROUP BY v."tipo"
    ORDER BY v."tipo"
  `;

  // ── 2. Lo que seguimos contando en piso, por año de compra ─────────────────
  // El renglón que decide: unidades viejas «disponibles» son salidas que nunca
  // empataron, no inventario.
  const enPisoPorAnio = await prisma.$queryRaw<
    Array<{ anio_compra: number | null; tipo: string; estado: string; unidades: bigint; costo: number | null }>
  >`
    SELECT EXTRACT(YEAR FROM COALESCE(i."fecha", v."createdAt"))::int AS anio_compra,
           v."tipo"::text AS tipo, v."estado"::text AS estado,
           COUNT(*)                    AS unidades,
           SUM(v."costoCompra")::float8 AS costo
    FROM "Vehiculo" v
    LEFT JOIN "Invoice" i ON i."id" = v."compraInvoiceId"
    WHERE v."companyId" = ${companyId}
      AND v."ventaInvoiceId" IS NULL
    GROUP BY 1, 2, 3
    ORDER BY 1 DESC NULLS LAST, costo DESC NULLS LAST
  `;

  // ── 3. Los CFDIs con clave de vehículo del ejercicio ───────────────────────
  // La clave 2510xx del SAT dice «vehículo» y nada más: NO distingue nuevo de
  // seminuevo — esa es una noción nuestra, del padrón. Así que esto cuadra el
  // documento contra el documento, no contra el tipo de unidad.
  //
  // Las notas de crédito (tipoSat "E") se netean con signo, no se suman: una
  // devolución no es una compra más.
  const cfdis = await prisma.$queryRaw<
    Array<{ tipo: string; facturas: bigint; bruto: number | null; notas_credito: number | null; neto: number | null }>
  >`
    WITH lineas AS (
      SELECT i."id" AS invoice_id, i."tipo"::text AS tipo,
             CASE WHEN i."tipoSat" = 'E' THEN -1 ELSE 1 END AS signo,
             (it."importe" - it."descuento") AS importe
      FROM "Invoice" i
      JOIN "InvoiceItem" it ON it."invoiceId" = i."id"
      WHERE i."companyId" = ${companyId}
        AND i."status" <> 'CANCELLED'
        AND i."fecha" >= ${desde} AND i."fecha" < ${hasta}
        AND it."claveProdServ" LIKE '2510%'
        AND i."tipo" IN ('INGRESO', 'EGRESO')
    )
    SELECT tipo,
           COUNT(DISTINCT invoice_id)                          AS facturas,
           SUM(importe) FILTER (WHERE signo =  1)::float8       AS bruto,
           SUM(importe) FILTER (WHERE signo = -1)::float8       AS notas_credito,
           SUM(importe * signo)::float8                         AS neto
    FROM lineas GROUP BY tipo
  `;

  // ── 4. Ventas con clave de vehículo que NUNCA empataron con una unidad ─────
  // El renglón que decide entre las dos causas posibles del piso inflado.
  //
  // Si el piso está inflado porque FALTAN CFDIs (los ocho meses que el SAT no
  // entregó), aquí no debería salir casi nada: la venta que no existe no puede
  // aparecer sin empatar. Si en cambio salen muchas, la venta SÍ está en la base
  // y lo que falló fue el empate con el VIN — otra causa, otro arreglo.
  //
  // Va por año y sin límite de ejercicio: la pregunta es histórica.
  const ventasHuerfanas = await prisma.$queryRaw<
    Array<{ anio: number | null; facturas: bigint; importe: number | null }>
  >`
    WITH ventas AS (
      SELECT i."id", i."fecha",
             SUM(it."importe" - it."descuento") AS importe
      FROM "Invoice" i
      JOIN "InvoiceItem" it ON it."invoiceId" = i."id"
      WHERE i."companyId" = ${companyId}
        AND i."tipo" = 'INGRESO'
        AND i."status" <> 'CANCELLED'
        AND i."tipoSat" <> 'E'
        AND it."claveProdServ" LIKE '2510%'
      GROUP BY i."id", i."fecha"
    )
    SELECT EXTRACT(YEAR FROM v."fecha")::int AS anio,
           COUNT(*)                  AS facturas,
           SUM(v."importe")::float8   AS importe
    FROM ventas v
    WHERE NOT EXISTS (
      SELECT 1 FROM "Vehiculo" ve
      WHERE ve."companyId" = ${companyId} AND ve."ventaInvoiceId" = v."id"
    )
    GROUP BY 1
    ORDER BY 1 DESC NULLS LAST
  `;

  const num = (v: number | null) => r2(v ?? 0);
  const n = (v: bigint) => Number(v);
  const ladoCfdi = (t: string) => {
    const f = cfdis.find((c) => c.tipo === t);
    return {
      facturas: f ? n(f.facturas) : 0,
      bruto: num(f?.bruto ?? 0),
      notasCredito: num(f?.notas_credito ?? 0),
      neto: num(f?.neto ?? 0),
    };
  };

  const padron = porTipo.map((t) => ({
    tipo: t.tipo,
    vendidas: n(t.vendidas),
    precioVenta: num(t.precio_venta),
    costoVendidas: num(t.costo_vendidas),
    enPiso: n(t.en_piso),
    costoEnPiso: num(t.costo_en_piso),
  }));

  const resp = {
    ok: true,
    companyId,
    anio,
    padron,
    totales: {
      enPiso: padron.reduce((s, t) => s + t.enPiso, 0),
      costoEnPiso: r2(padron.reduce((s, t) => s + t.costoEnPiso, 0)),
      vendidas: padron.reduce((s, t) => s + t.vendidas, 0),
      costoVendidas: r2(padron.reduce((s, t) => s + t.costoVendidas, 0)),
    },
    // Ordenado del año más reciente al más viejo: lo de abajo es lo sospechoso.
    enPisoPorAnio: enPisoPorAnio.map((r) => ({
      anioCompra: r.anio_compra,
      tipo: r.tipo,
      estado: r.estado,
      unidades: n(r.unidades),
      costo: num(r.costo),
    })),
    cfdisClaveVehiculo: { ventas: ladoCfdi("INGRESO"), compras: ladoCfdi("EGRESO") },
    // Ventas facturadas que nunca sacaron una unidad del piso, por año.
    ventasHuerfanas: ventasHuerfanas.map((r) => ({
      anio: r.anio,
      facturas: n(r.facturas),
      importe: num(r.importe),
    })),
    nota:
      "costoEnPiso se compara contra la suma de las familias 1301/1302/1312 de la balanza. " +
      "La clave 2510xx no distingue nuevo de seminuevo: eso sólo lo sabe el padrón. " +
      "ventasHuerfanas distingue las dos causas del piso inflado: si sale casi vacío, " +
      "faltan CFDIs (ingesta); si sale grande, la venta está y falló el empate con el VIN.",
  };

  console.log(
    "[cron/inventario-cuadre]",
    JSON.stringify({ companyId, anio, ...resp.totales, filas: resp.enPisoPorAnio.length }),
  );
  return NextResponse.json(resp);
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
