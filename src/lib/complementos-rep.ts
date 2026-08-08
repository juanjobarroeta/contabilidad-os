// ─────────────────────────────────────────────────────────────────────────────
// Complemento de Pago (REP / CFDI de Pago 2.0) — NÚCLEO PURO de cálculo.
//
// Deriva, para UNA parcialidad, los campos que exige el nodo DoctoRelacionado del
// complemento de pago 2.0: NumParcialidad, ImpSaldoAnt, ImpPagado, ImpSaldoInsoluto
// y el desglose de impuestos (ImpuestosDR) prorrateado a la fracción pagada. Es
// PURO (sin Prisma/Facturapi) para poder probar la aritmética fiscal en aislamiento
// — que es justo donde se esconden los errores de centavos y de parcialidad.
//
// Convención de montos: ImpSaldoAnt/ImpPagado/ImpSaldoInsoluto van CON impuestos
// (el pago cubre el importe facturado incluyendo IVA). El desglose ImpuestosDR
// detalla cuánto IVA va DENTRO de ese pago (base × tasa sobre la fracción pagada).
// ─────────────────────────────────────────────────────────────────────────────

/** Fila InvoiceTax de la factura padre (a nivel comprobante). */
export interface RepParentTax {
  tipo: "IVA" | "ISR" | "IEPS";
  factor: "TASA" | "CUOTA" | "EXENTO";
  tasa: number; // p.ej. 0.16
  base: number | null; // null en filas legacy → se usa parentSubtotal
  importe: number;
  retencion: boolean;
}

export interface RepComputeInput {
  /** Total CON impuestos de la factura padre. */
  parentTotal: number;
  /** Subtotal de la factura padre (respaldo cuando InvoiceTax.base es null). */
  parentSubtotal: number;
  /** Σ ImpPagado de las parcialidades YA emitidas para este padre. */
  priorImpPagado: number;
  /** Número de REP ya emitidos para este padre (para NumParcialidad). */
  priorCount: number;
  /** ImpPagado de ESTA parcialidad (con impuestos). */
  paymentAmount: number;
  /** Impuestos del comprobante padre. */
  parentTaxes: RepParentTax[];
  /** Tolerancia en pesos para el chequeo de sobrepago. Default 0.01. */
  toleranciaPesos?: number;
}

/** Un traslado/retención del DoctoRelacionado (formato SAT/Facturapi). */
export interface RepImpuestoDR {
  tipo: "IVA" | "ISR" | "IEPS";
  factor: "Tasa" | "Cuota";
  tasa: number;
  base: number;
  importe: number;
  retencion: boolean;
}

export interface RepDoctoRelacionado {
  numParcialidad: number;
  impSaldoAnterior: number;
  impPagado: number;
  impSaldoInsoluto: number;
  /** ObjetoImpDR: "02" (sí objeto) si hay impuestos, "01" (no objeto) si no. */
  objetoImp: "01" | "02";
  traslados: RepImpuestoDR[];
  retenciones: RepImpuestoDR[];
  /** Agregados de IVA trasladado, para persistir en PagoDoctoRelacionado. */
  baseTrasladoIva: number;
  ivaTrasladado: number;
}

export type RepComputeResult =
  | { ok: true; docto: RepDoctoRelacionado }
  | { ok: false; error: string };

/** Redondeo bancario a centavos (2 decimales). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Calcula el DoctoRelacionado de UNA parcialidad. Valida que el pago no exceda el
 * saldo pendiente (con tolerancia de centavos) y prorratea los impuestos del padre
 * a la fracción pagada. No emite nada: solo aritmética.
 */
export function computeRepDoctoRelacionado(input: RepComputeInput): RepComputeResult {
  const tol = input.toleranciaPesos ?? 0.01;

  const impPagado = round2(input.paymentAmount);
  if (!(impPagado > 0)) {
    return { ok: false, error: "El monto del pago debe ser mayor a cero." };
  }

  const impSaldoAnterior = round2(input.parentTotal - input.priorImpPagado);
  if (impSaldoAnterior <= 0) {
    return { ok: false, error: "La factura ya está pagada por completo; no hay saldo para un nuevo complemento." };
  }
  if (impPagado > impSaldoAnterior + tol) {
    return {
      ok: false,
      error: `El pago (${impPagado.toFixed(2)}) excede el saldo pendiente de la factura (${impSaldoAnterior.toFixed(2)}).`,
    };
  }

  // Si el pago deja el saldo por debajo de la tolerancia, ciérralo en 0 exacto.
  let impSaldoInsoluto = round2(impSaldoAnterior - impPagado);
  if (Math.abs(impSaldoInsoluto) <= tol) impSaldoInsoluto = 0;

  const numParcialidad = input.priorCount + 1;

  // Fracción pagada sobre el total con impuestos.
  const fraccion = input.parentTotal > 0 ? impPagado / input.parentTotal : 0;

  const traslados: RepImpuestoDR[] = [];
  const retenciones: RepImpuestoDR[] = [];
  for (const t of input.parentTaxes) {
    if (t.factor === "EXENTO") continue; // exento no lleva importe en el DR
    const baseFull = t.base ?? input.parentSubtotal;
    const baseDR = round2(baseFull * fraccion);
    const importeDR = round2(baseDR * t.tasa);
    const dr: RepImpuestoDR = {
      tipo: t.tipo,
      factor: t.factor === "TASA" ? "Tasa" : "Cuota",
      tasa: t.tasa,
      base: baseDR,
      importe: importeDR,
      retencion: t.retencion,
    };
    (t.retencion ? retenciones : traslados).push(dr);
  }

  const hayImpuestos = traslados.length > 0 || retenciones.length > 0;
  const ivaTraslados = traslados.filter((x) => x.tipo === "IVA");
  const baseTrasladoIva = round2(ivaTraslados.reduce((s, x) => s + x.base, 0));
  const ivaTrasladado = round2(ivaTraslados.reduce((s, x) => s + x.importe, 0));

  return {
    ok: true,
    docto: {
      numParcialidad,
      impSaldoAnterior,
      impPagado,
      impSaldoInsoluto,
      objetoImp: hayImpuestos ? "02" : "01",
      traslados,
      retenciones,
      baseTrasladoIva,
      ivaTrasladado,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback: sintetizar los impuestos del padre desde sus TOTALES.
//
// Las facturas timbradas en la app antes de que persistiéramos InvoiceTax no
// tienen filas de impuesto NI rawXml del cual derivarlas (el XML vive en el
// PAC). Sin filas, el REP salía con ObjetoImpDR "01" y sin taxes — y Facturapi
// lo rechaza cuando el padre sí traía IVA. Para esas facturas, la diferencia
// total − subtotal delata el impuesto: si corresponde EXACTAMENTE a una tasa
// de IVA del catálogo sobre el subtotal, se sintetiza esa única fila.
//
// Deliberadamente conservador: si el delta no cuadra con una tasa conocida
// (mezcla de tasas, retenciones, IEPS), NO se inventa nada — el caller debe
// rechazar con un mensaje claro en vez de timbrar un desglose incorrecto.
// ─────────────────────────────────────────────────────────────────────────────

/** Tasas de IVA trasladado reconocidas para la síntesis (general y fronteriza). */
const TASAS_IVA_SINTESIS = [0.16, 0.08] as const;

/**
 * Deriva las filas de impuesto del padre desde subtotal/total cuando no hay
 * InvoiceTax persistido. Devuelve:
 *   - []    si total ≈ subtotal (sin impuestos que desglosar),
 *   - [fila] si el delta corresponde a UNA tasa de IVA conocida,
 *   - null  si el delta existe pero no cuadra con ninguna tasa (no inventar).
 */
export function sintetizarParentTaxes(
  parentSubtotal: number,
  parentTotal: number
): RepParentTax[] | null {
  const delta = round2(parentTotal - parentSubtotal);
  if (Math.abs(delta) <= 0.01) return [];
  // Delta negativo = retenciones netas: imposible saber cuáles sin las filas.
  if (delta < 0 || !(parentSubtotal > 0)) return null;

  for (const tasa of TASAS_IVA_SINTESIS) {
    // Tolerancia de 2 centavos: redondeos por partida pueden desviar 1¢.
    if (Math.abs(round2(parentSubtotal * tasa) - delta) <= 0.02) {
      return [
        { tipo: "IVA", factor: "TASA", tasa, base: round2(parentSubtotal), importe: delta, retencion: false },
      ];
    }
  }
  return null;
}
