// ─────────────────────────────────────────────────────────────────────────────
// FARMACIA POR ALMACÉN Y POR ORIGEN — lo que la lista enseña y cómo se filtra.
//
// ORIGEN. El catálogo de la farmacia es el que cargó el inventario físico
// (scripts/importar-inventario.ts, #1292): lo que su sistema actual enseña.
// Los insumos que nacieron SÓLO de leer CFDIs de proveedores
// (`derivadoDeCfdi` y sin un solo lote) no son inventario: son conceptos de
// factura que alguien tiene que revisar y fusionar. Por eso la lista arranca en
// INVENTARIO y los otros se ven aparte.
//
// ALMACÉN. La verdad de la existencia sigue siendo el KARDEX (Σ
// HospMovimientoInsumo.cantidad, #1292). Por almacén se reparte el kardex por
// el almacén del LOTE al que está ligado cada movimiento. Un movimiento sin
// lote (p. ej. una entrada derivada de un CFDI) no tiene almacén: cuenta en el
// total del insumo y aparece como «SIN ALMACÉN» en el desglose. PURO.
// ─────────────────────────────────────────────────────────────────────────────

export const SIN_ALMACEN = "SIN ALMACÉN";

export type OrigenInsumo = "INVENTARIO" | "CFDI";
export const ORIGENES = ["INVENTARIO", "CFDI", "TODOS"] as const;
export type FiltroOrigen = (typeof ORIGENES)[number];

/** INVENTARIO = capturado/cargado (no derivado) o con algún lote; CFDI = sólo derivado de facturas, sin lotes. */
export function origenDe(i: { derivadoDeCfdi: boolean; lotes: number }): OrigenInsumo {
  return !i.derivadoDeCfdi || i.lotes > 0 ? "INVENTARIO" : "CFDI";
}

export function pasaOrigen(filtro: FiltroOrigen, origen: OrigenInsumo): boolean {
  return filtro === "TODOS" || filtro === origen;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface MovAgrupado { insumoId: string; loteId: string | null; cantidad: number }
export interface LoteAlmacen { almacen: string; costoUnitario: number }

/**
 * Reparte el kardex por almacén. Devuelve, por insumo, las piezas por almacén;
 * y el resumen del selector (productos con existencia > 0, piezas y valor a
 * costo del lote) sólo de los insumos en `incluir`.
 */
export function repartirPorAlmacen(
  movs: MovAgrupado[],
  lotes: Map<string, LoteAlmacen>,
  incluir?: Set<string>,
): {
  porInsumo: Map<string, Map<string, number>>;
  resumen: { almacen: string; productos: number; piezas: number; valor: number }[];
} {
  const porInsumo = new Map<string, Map<string, number>>();
  const valorPor = new Map<string, number>();
  for (const m of movs) {
    const l = m.loteId ? lotes.get(m.loteId) : undefined;
    const almacen = l?.almacen ?? SIN_ALMACEN;
    const mapa = porInsumo.get(m.insumoId) ?? new Map<string, number>();
    mapa.set(almacen, r2((mapa.get(almacen) ?? 0) + m.cantidad));
    porInsumo.set(m.insumoId, mapa);
    if (!incluir || incluir.has(m.insumoId)) {
      valorPor.set(almacen, (valorPor.get(almacen) ?? 0) + m.cantidad * (l?.costoUnitario ?? 0));
    }
  }
  const agg = new Map<string, { productos: number; piezas: number }>();
  for (const [insumoId, mapa] of porInsumo) {
    if (incluir && !incluir.has(insumoId)) continue;
    for (const [almacen, piezas] of mapa) {
      const a = agg.get(almacen) ?? { productos: 0, piezas: 0 };
      a.piezas = r2(a.piezas + piezas);
      if (piezas > 0) a.productos += 1;
      agg.set(almacen, a);
    }
  }
  const resumen = [...agg.entries()]
    .map(([almacen, a]) => ({ almacen, productos: a.productos, piezas: a.piezas, valor: r2(valorPor.get(almacen) ?? 0) }))
    // El general primero, luego por piezas; «SIN ALMACÉN» al final.
    .sort((x, y) =>
      x.almacen === SIN_ALMACEN ? 1 : y.almacen === SIN_ALMACEN ? -1 : y.piezas - x.piezas || x.almacen.localeCompare(y.almacen));
  return { porInsumo, resumen };
}
