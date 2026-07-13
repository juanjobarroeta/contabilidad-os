/**
 * Restaurante module helpers shared across /api/restaurante routes.
 */

export const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Splits an IVA-included total (menu prices are IVA-incluido) into
 * subtotal + iva at the given rate. subtotal + iva === total exactly
 * (iva absorbs the rounding remainder).
 */
export function splitIvaIncluidoRest(total: number, ivaRate: number) {
  const subtotal = round2(total / (1 + ivaRate));
  const iva = round2(total - subtotal);
  return { subtotal, iva };
}

type ItemWithReceta = {
  precio: number;
  receta: Array<{ cantidad: number; insumo: { costoPromedio: number } }>;
};

/**
 * Theoretical costing for a menu item against CURRENT insumo average costs.
 * Never persisted on the item — frozen per orden item only at charge time.
 */
export function computeCosting(item: ItemWithReceta, ivaRate: number) {
  const costoTeorico = round2(
    item.receta.reduce((sum, r) => sum + r.cantidad * r.insumo.costoPromedio, 0)
  );
  const precioSinIva = round2(item.precio / (1 + ivaRate));
  const margen =
    precioSinIva > 0
      ? Math.round(((precioSinIva - costoTeorico) / precioSinIva) * 1000) / 1000
      : 0;
  const foodCostPct =
    precioSinIva > 0 ? Math.round((costoTeorico / precioSinIva) * 1000) / 1000 : 0;
  return { costoTeorico, precioSinIva, margen, foodCostPct };
}
