// ─────────────────────────────────────────────────────────────────────────────
// Inventario PERIÓDICO (Fase 1) — la matemática pura del costo de venta.
//
//   costo = inventario inicial + entradas del período − inventario final
//
// (Arts. 39 y 41 LISR: el costo de lo vendido se deduce al vender; el método
// periódico lo determina por diferencia contra el conteo físico.) Las ENTRADAS
// son lo que el motor cargó a la cuenta de inventario (compras G01 → 115); el
// CONTEO lo captura el humano en Cierre. postMonth postea el resultado como
// DR Costo de venta / CR Inventario (fuente INVENTARIO, regenerable).
//
// Un conteo MAYOR que inicial+entradas significa que el físico encontró más de
// lo que los libros registran (compra sin CFDI, error de conteo previo): el
// ajuste sale invertido (DR Inventario / CR Costo) y se advierte — nunca se
// esconde.
// ─────────────────────────────────────────────────────────────────────────────

export interface CostoPeriodicoInput {
  /** Saldo de la cuenta de inventario al inicio del período (deudor +). */
  saldoInicial: number;
  /** Cargos − abonos del período en la cuenta de inventario (antes del ajuste). */
  entradasNetas: number;
  /** Valor del inventario físico al cierre (conteo capturado). */
  valorFinal: number;
}

export interface CostoPeriodicoResult {
  /** Positivo = costo de venta (DR 501 / CR 115); negativo = ajuste a favor. */
  costo: number;
  advertencia: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function costoPeriodico(i: CostoPeriodicoInput): CostoPeriodicoResult {
  const costo = r2(i.saldoInicial + i.entradasNetas - i.valorFinal);
  if (costo < -0.005) {
    return {
      costo,
      advertencia:
        `El conteo físico ($${i.valorFinal.toFixed(2)}) supera al inventario según libros ` +
        `($${r2(i.saldoInicial + i.entradasNetas).toFixed(2)}): el ajuste sale invertido. ` +
        "Revisa el conteo o busca entradas sin comprobante.",
    };
  }
  return { costo, advertencia: null };
}
