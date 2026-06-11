// ─────────────────────────────────────────────────────────────────────────────
// IVA — proporción de acreditamiento (Art. 5, fracc. V LIVA).
//
// Cuando el contribuyente realiza actos GRAVADOS (16% y tasa 0%) y también
// actos EXENTOS, el IVA de los gastos sólo es acreditable en la proporción que
// el valor de los actos gravados representa del total de actos del mes:
//
//   proporción = gravados / (gravados + exentos)
//
// La tasa 0% SÍ es acto gravado (cuenta en el numerador); "exento" no. Los
// actos NO OBJETO no son actividades para LIVA y quedan fuera de ambos
// términos (un CFDI sin nodo Impuestos no aporta a la proporción).
//
// v1: cuando hay exentos, TODO el IVA acreditable se trata como de gastos
// "indistintos" (Art. 5-V inciso c) — no existe aún etiquetado por gasto de
// destino exclusivo gravado/exento. Refinamiento futuro: clasificar gasto por
// gasto (exclusivo gravado → 100%, exclusivo exento → 0%, mixto → proporción).
// ─────────────────────────────────────────────────────────────────────────────

export interface InvoiceConTaxes {
  subtotal: number;
  taxes: { tipo: string; factor: string; base: number | null; importe: number; retencion: boolean }[];
}

export interface ActosDelPeriodo {
  /** Valor de actos gravados del mes (tasa 16%, 0% y cuota). */
  gravados: number;
  /** Valor de actos exentos del mes (TipoFactor="Exento"). */
  exentos: number;
  /** gravados / (gravados + exentos); 1 cuando no hay exentos. */
  proporcion: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Computes the month's actos gravados/exentos from the INGRESO invoices'
 * IVA breakdown (InvoiceTax rows parsed from the CFDI's invoice-level
 * Impuestos node) and the resulting proporción de acreditamiento.
 */
export function calcularActosDelPeriodo(facturasIngreso: InvoiceConTaxes[]): ActosDelPeriodo {
  let gravados = 0;
  let exentos = 0;
  for (const inv of facturasIngreso) {
    const ivaRows = inv.taxes.filter((t) => t.tipo === "IVA" && !t.retencion);
    // Sin desglose de IVA: CFDI no objeto (no es actividad para LIVA) o factura
    // legacy aún sin backfill — fuera de ambos términos de la proporción.
    if (ivaRows.length === 0) continue;
    const conBase = ivaRows.filter((row) => row.base != null);
    if (conBase.length === 0) {
      // Filas sin Base (sintéticas legacy o CFDI 3.3 sin Base a nivel
      // comprobante): el comprobante completo se asume gravado — equivale al
      // comportamiento previo (acreditamiento al 100%).
      gravados += inv.subtotal;
      continue;
    }
    for (const row of conBase) {
      if (row.factor === "EXENTO") exentos += row.base!;
      else gravados += row.base!;
    }
  }
  const total = gravados + exentos;
  const proporcion = exentos > 0 && total > 0 ? gravados / total : 1;
  return { gravados: r2(gravados), exentos: r2(exentos), proporcion };
}
