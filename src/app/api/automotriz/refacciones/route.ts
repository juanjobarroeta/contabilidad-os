import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automotriz/refacciones?companyId=…&q=…&tab=…&page=1
//
// El catálogo visto como lo piensa el jefe de refacciones: ¿DÓNDE está la
// parte y cuánta tengo DE VERDAD?
//
//   existencia   = Σ kardex (entradas − salidas)
//   comprometida = en líneas de órdenes de servicio ABIERTAS (aún sin facturar)
//   disponible   = existencia − comprometida   ← la cifra que evita el
//                  «sí hay… no, ya estaba apartada»
//
// Pestañas (tab): ALMACEN (en anaquel) · PROCESO (comprometida en órdenes) ·
// PEDIR (agotada pero con demanda en 12m — la lista de reorden) · MUERTAS
// (con existencia y sin moverse 12m — candidatas a reserva/liquidación) ·
// TODAS. `porTab` trae los conteos para las pestañas, respetando la búsqueda.
//
// El VALOR y el MARGEN sólo se calculan con costo COMPARABLE (misma regla que
// calcularResultados: unidad de compra = unidad de venta, y costo ≤ 2× precio
// — el tambo de 208L no infla el valor del anaquel). Sin costo comparable van
// null, no un número inventado.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;
const r2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);

const TABS = ["ALMACEN", "PROCESO", "PEDIR", "MUERTAS", "TODAS"] as const;
type Tab = (typeof TABS)[number];

const TAB_WHERE: Record<Tab, string> = {
  ALMACEN: "existencia > 0.005",
  PROCESO: "comprometida > 0.005",
  PEDIR: "disponible <= 0.005 AND demanda12m > 0",
  MUERTAS: "existencia > 0.005 AND (ultimo_mov IS NULL OR ultimo_mov < NOW() - interval '12 months')",
  TODAS: "TRUE",
};
const TAB_ORDER: Record<Tab, string> = {
  ALMACEN: "descripcion ASC",
  PROCESO: "comprometida * COALESCE(costo, 0) DESC, comprometida DESC",
  PEDIR: "demanda12m DESC",
  MUERTAS: "COALESCE(valor, 0) DESC",
  TODAS: "descripcion ASC",
};

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const q = (searchParams.get("q") ?? "").trim();
  // Sin `tab` = TODAS: el satélite viejo (ventana de despliegue) sigue viendo
  // el catálogo completo; el nuevo pide ALMACEN explícito.
  const tabParam = (searchParams.get("tab") ?? "TODAS").toUpperCase();
  const tab: Tab = (TABS as readonly string[]).includes(tabParam) ? (tabParam as Tab) : "ALMACEN";
  const page = Math.max(1, Number(searchParams.get("page") ?? 1) || 1);

  // Búsqueda parametrizada ($2 cuando hay q). Los agregados corren sobre las
  // partes YA filtradas — una búsqueda acota todo el trabajo, no sólo la página.
  const filtroQ = q ? `AND (r."numeroParte" ILIKE $2 OR r.descripcion ILIKE $2)` : "";
  const params: unknown[] = q ? [companyId, `%${q}%`] : [companyId];

  const baseSql = `
    WITH sel AS (
      SELECT r.id, r."numeroParte", r.descripcion,
        r."ultimoCosto"::float8 AS costo_raw, r."ultimoPrecio"::float8 AS precio,
        NULLIF(r."factorCosto", 0)::float8 AS factor,
        (r."ultimoCosto" > 0
          AND (r."unidadCosto" IS NULL OR r."unidadPrecio" IS NULL OR r."unidadCosto" = r."unidadPrecio")
          AND NOT (COALESCE(r."ultimoPrecio", 0) > 0 AND r."ultimoCosto" > COALESCE(r."ultimoPrecio", 0) * 2)
        ) AS costo_ok
      FROM "Refaccion" r
      WHERE r."companyId" = $1 ${filtroQ}
    ),
    mov AS (
      -- La existencia se normaliza a la UNIDAD DE VENTA: una ENTRADA con
      -- factor (tambo de 208 L) vale cantidad × factor; salidas y ajustes ya
      -- viven en la unidad de venta (misma doctrina que unidad-refaccion.ts).
      SELECT m."refaccionId" AS rid,
        COALESCE(SUM(CASE WHEN m.tipo = 'ENTRADA_COMPRA' AND s.factor IS NOT NULL
                          THEN m.cantidad * s.factor ELSE m.cantidad END), 0)::float8 AS existencia,
        COUNT(*)::int AS movs,
        MAX(m.fecha) AS ultimo_mov,
        COALESCE(SUM(CASE WHEN m.tipo = 'SALIDA_VENTA' AND m.fecha >= NOW() - interval '12 months'
                          THEN -m.cantidad ELSE 0 END), 0)::float8 AS demanda12m
      FROM "RefaccionMovimiento" m
      JOIN sel s ON s.id = m."refaccionId"
      GROUP BY 1
    ),
    comp AS (
      SELECT l."refaccionId" AS rid, COALESCE(SUM(l.cantidad), 0)::float8 AS comprometida
      FROM "OrdenServicioLinea" l
      JOIN "OrdenServicio" o ON o.id = l."ordenId"
      WHERE o."companyId" = $1 AND o.estado IN ('RECIBIDA', 'EN_PROCESO', 'LISTA')
        AND l.tipo = 'REFACCION' AND l."refaccionId" IS NOT NULL
      GROUP BY 1
    ),
    base AS (
      SELECT s.id, s."numeroParte", s.descripcion, s.precio,
        CASE WHEN s.factor IS NOT NULL THEN s.costo_raw / s.factor
             WHEN s.costo_ok THEN s.costo_raw END AS costo,
        (s.factor IS NOT NULL OR s.costo_ok) AS costo_ok,
        COALESCE(mov.existencia, 0) AS existencia,
        COALESCE(mov.movs, 0) AS movs,
        mov.ultimo_mov,
        COALESCE(mov.demanda12m, 0) AS demanda12m,
        COALESCE(comp.comprometida, 0) AS comprometida,
        COALESCE(mov.existencia, 0) - COALESCE(comp.comprometida, 0) AS disponible,
        CASE WHEN COALESCE(mov.existencia, 0) > 0 THEN
          COALESCE(mov.existencia, 0) *
          CASE WHEN s.factor IS NOT NULL THEN s.costo_raw / s.factor
               WHEN s.costo_ok THEN s.costo_raw END
        END AS valor
      FROM sel s
      LEFT JOIN mov ON mov.rid = s.id
      LEFT JOIN comp ON comp.rid = s.id
    )`;

  const [filas, conteos] = await Promise.all([
    prisma.$queryRawUnsafe<any[]>(
      `${baseSql}
       SELECT * FROM base WHERE ${TAB_WHERE[tab]}
       ORDER BY ${TAB_ORDER[tab]}
       LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      ...params
    ),
    prisma.$queryRawUnsafe<any[]>(
      `${baseSql}
       SELECT
         COUNT(*) FILTER (WHERE ${TAB_WHERE.ALMACEN})::int AS almacen,
         COUNT(*) FILTER (WHERE ${TAB_WHERE.PROCESO})::int AS proceso,
         COUNT(*) FILTER (WHERE ${TAB_WHERE.PEDIR})::int AS pedir,
         COUNT(*) FILTER (WHERE ${TAB_WHERE.MUERTAS})::int AS muertas,
         COUNT(*)::int AS todas,
         COALESCE(SUM(valor) FILTER (WHERE ${TAB_WHERE.ALMACEN}), 0)::float8 AS valor_almacen,
         COALESCE(SUM(comprometida * costo) FILTER (WHERE ${TAB_WHERE.PROCESO}), 0)::float8 AS valor_proceso,
         COALESCE(SUM(valor) FILTER (WHERE ${TAB_WHERE.MUERTAS}), 0)::float8 AS valor_muertas
       FROM base`,
      ...params
    ),
  ]);

  const c = conteos[0] ?? {};
  const totalTab = { ALMACEN: c.almacen, PROCESO: c.proceso, PEDIR: c.pedir, MUERTAS: c.muertas, TODAS: c.todas }[tab] ?? 0;

  return NextResponse.json({
    tab,
    total: totalTab,
    page,
    pageSize: PAGE_SIZE,
    porTab: {
      ALMACEN: c.almacen ?? 0, PROCESO: c.proceso ?? 0, PEDIR: c.pedir ?? 0,
      MUERTAS: c.muertas ?? 0, TODAS: c.todas ?? 0,
    },
    valores: {
      almacen: r2(c.valor_almacen) ?? 0,
      proceso: r2(c.valor_proceso) ?? 0,
      muertas: r2(c.valor_muertas) ?? 0,
    },
    refacciones: filas.map((f) => ({
      id: f.id,
      numeroParte: f.numeroParte,
      descripcion: f.descripcion,
      ultimoCosto: r2(f.costo_ok ? f.costo : null), // null = costo no comparable
      ultimoPrecio: r2(f.precio),
      existencia: r2(f.existencia) ?? 0,
      comprometida: r2(f.comprometida) ?? 0,
      disponible: r2(f.disponible) ?? 0,
      demanda12m: r2(f.demanda12m) ?? 0,
      ultimoMov: f.ultimo_mov,
      movimientos: f.movs,
      valorInventario: r2(f.valor),
      margenPct:
        f.costo != null && (f.precio ?? 0) > 0
          ? Math.round(((f.precio - f.costo) / f.precio) * 1000) / 10
          : null,
    })),
  });
});
