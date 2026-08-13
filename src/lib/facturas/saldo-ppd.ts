// ─────────────────────────────────────────────────────────────────────────────
// Saldo insoluto de una factura PPD a partir de sus doctos relacionados (REPs).
//
// La fuente más confiable es el PROPIO complemento: cada docto declara el saldo
// que queda después de esa parcialidad (ImpSaldoInsoluto). Se toma el del docto
// más avanzado — mayor NumParcialidad y, a igual parcialidad (o sin ella), el de
// fecha de pago más reciente. Sólo si ningún docto declara saldo se cae a la
// resta total − Σ pagado. Todo acotado a [0, total]: un complemento chueco no
// debe producir saldos negativos ni mayores al total.
//
// PURA — sin BD. La consumen las tools del asistente y cualquier vista de
// cartera. (El motor de créditos calcula lo suyo en insumos.ts con reglas
// equivalentes; unificar ahí es refactor aparte.)
// ─────────────────────────────────────────────────────────────────────────────

export interface DoctoRelacionadoSaldo {
  numParcialidad: number | null;
  impPagado: number | null;
  impSaldoInsoluto: number | null;
  fechaPago: Date | null;
}

export interface SaldoPpd {
  /** Saldo pendiente de cobro, acotado a [0, total]. */
  saldo: number;
  /** Suma de lo pagado en los complementos, acotada a [0, total]. */
  pagado: number;
  /** Número de parcialidades registradas. */
  parcialidades: number;
  /** Fecha legal del último pago (fechaPago del docto, no la del REP). */
  ultimoPago: Date | null;
}

export function saldoInsolutoPpd(total: number, doctos: DoctoRelacionadoSaldo[]): SaldoPpd {
  const clamp = (n: number) => Math.min(Math.max(n, 0), Math.max(total, 0));

  const pagado = clamp(doctos.reduce((s, d) => s + (d.impPagado ?? 0), 0));
  const ultimoPago = doctos.reduce<Date | null>(
    (max, d) => (d.fechaPago && (!max || d.fechaPago > max) ? d.fechaPago : max),
    null,
  );

  // El docto más avanzado que DECLARA saldo manda.
  const conSaldo = doctos.filter((d) => d.impSaldoInsoluto != null);
  if (conSaldo.length > 0) {
    const masAvanzado = conSaldo.reduce((a, b) => {
      const pa = a.numParcialidad ?? -1;
      const pb = b.numParcialidad ?? -1;
      if (pa !== pb) return pa > pb ? a : b;
      const fa = a.fechaPago?.getTime() ?? -1;
      const fb = b.fechaPago?.getTime() ?? -1;
      return fa >= fb ? a : b;
    });
    return {
      saldo: clamp(masAvanzado.impSaldoInsoluto as number),
      pagado,
      parcialidades: doctos.length,
      ultimoPago,
    };
  }

  return { saldo: clamp(total - pagado), pagado, parcialidades: doctos.length, ultimoPago };
}
