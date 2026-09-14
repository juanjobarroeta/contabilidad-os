// ─────────────────────────────────────────────────────────────────────────────
// IVA ACREDITABLE DE UN GASTO PUE, EN FLUJO (Art. 5-I LIVA).
//
// La ley acredita el IVA de un gasto cuando se PAGA efectivamente, no cuando
// se emite el CFDI. Para un PPD la prueba de pago es el REP y el motor ya lo
// prorratea. Para un PUE el motor ASUMÍA pagado al emitirse y el papel de
// trabajo lo avisaba en un banner: dos verdades distintas para el mismo mes,
// y el copiloto contestaba una y el papel otra.
//
// Aquí vive la ÚNICA regla, y la leen los dos:
//
//   · La prueba de pago de un PUE es la CONCILIACIÓN BANCARIA: porciones de
//     ConciliacionDetalle + el vínculo 1:1 legado, contando SÓLO movimientos
//     cuya fecha cae en el periodo. Se acredita en el mes en que se PAGÓ,
//     aunque el CFDI sea de un mes anterior — igual que el PPD por REP.
//   · Pagado completo → todo el IVA (neto de retención). Pagado en parte →
//     PRORRATEADO por lo pagado ÷ total, con la misma aritmética que
//     repIvaRetenidoDe para el PPD. Sin pago en el periodo → 0.
//   · Empresa que NO concilia banco (cero movimientos): se conserva la
//     suposición de siempre —PUE pagado al emitirse— porque tratar «no
//     concilia» como «no pagó» dejaría a esa empresa sin IVA acreditable. El
//     resultado dice qué modo aplicó, para que el papel lo escriba.
//   · Lo que el contador marcó a mano (ivaNoAcreditable) sigue mandando.
//
// La decisión es PURA (aplicarFlujoPue); la consulta que junta los pagos del
// periodo está aparte (pagosPueDelPeriodo).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { pagadaCompleta } from "./conciliacion-pue";

export type ModoPue = "FLUJO" | "SUPUESTO_PAGADO";

export interface PagoPue {
  /** Lo pagado a esta factura en el periodo (banco), en positivo. */
  pagadoEnPeriodo: number;
  /** Lo pagado a esta factura en TODA la historia (para «ya se pagó completa antes»). */
  pagadoAcumulado: number;
}

export interface ResultadoFlujoPue {
  /** IVA acreditable en el periodo tras aplicar la regla. */
  acreditable: number;
  /** Fracción de la factura que se acredita este periodo (0..1). */
  fraccion: number;
  estado: "PAGADA" | "PARCIAL" | "SIN_PAGO" | "SUPUESTO";
}

/**
 * Cuánto del IVA de un PUE se acredita ESTE periodo. PURA.
 * `ivaNeto` = IVA trasladado − retenido de la factura (Art. 5-IV ya aplicado).
 */
export function aplicarFlujoPue(
  factura: { total: number; ivaNeto: number },
  pago: PagoPue | null,
  modo: ModoPue,
): ResultadoFlujoPue {
  const ivaNeto = Math.max(0, factura.ivaNeto);
  if (modo === "SUPUESTO_PAGADO") return { acreditable: ivaNeto, fraccion: 1, estado: "SUPUESTO" };
  const total = Math.abs(factura.total);
  const enPeriodo = Math.max(0, pago?.pagadoEnPeriodo ?? 0);
  if (total <= 0 || enPeriodo <= 0.005) return { acreditable: 0, fraccion: 0, estado: "SIN_PAGO" };
  // Lo pagado en el periodo, acotado al total: un pago de más (comisión,
  // redondeo) no acredita más IVA del que la factura trae.
  const fraccion = Math.min(1, enPeriodo / total);
  const completa = pagadaCompleta(total, enPeriodo);
  return {
    acreditable: Math.round(ivaNeto * (completa ? 1 : fraccion) * 100) / 100,
    fraccion: completa ? 1 : fraccion,
    estado: completa ? "PAGADA" : "PARCIAL",
  };
}

/**
 * Pagos bancarios aplicados a cada factura: en el periodo [from, to) y en
 * total. Porciones (ConciliacionDetalle) + 1:1 legado; un movimiento que paga
 * varias facturas deja invoiceId en NULL, así que no hay doble conteo.
 */
export async function pagosPueDelPeriodo(
  invoiceIds: string[],
  from: Date,
  to: Date,
): Promise<Map<string, PagoPue>> {
  const out = new Map<string, PagoPue>();
  if (invoiceIds.length === 0) return out;
  const [unoAUno, porciones] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: { invoiceId: { in: invoiceIds }, status: "MATCHED" },
      select: { invoiceId: true, monto: true, fecha: true },
    }),
    prisma.conciliacionDetalle.findMany({
      where: { invoiceId: { in: invoiceIds }, bankTransaction: { status: "MATCHED" } },
      select: { invoiceId: true, montoAsignado: true, bankTransaction: { select: { fecha: true } } },
    }),
  ]);
  const suma = (id: string, monto: number, fecha: Date) => {
    const p = out.get(id) ?? { pagadoEnPeriodo: 0, pagadoAcumulado: 0 };
    p.pagadoAcumulado += monto;
    if (fecha >= from && fecha < to) p.pagadoEnPeriodo += monto;
    out.set(id, p);
  };
  for (const t of unoAUno) if (t.invoiceId) suma(t.invoiceId, Math.abs(Number(t.monto)), t.fecha);
  for (const d of porciones) suma(d.invoiceId, Math.abs(Number(d.montoAsignado)), d.bankTransaction.fecha);
  return out;
}

/**
 * Gastos PUE de meses ANTERIORES pagados (conciliados) en este periodo: se
 * acreditan aquí, igual que un PPD pagado por REP. Devuelve los ids con lo
 * pagado en el periodo, para que el motor y el papel los carguen por id.
 */
export async function puesAnterioresPagadosEnPeriodo(
  companyId: string,
  from: Date,
  to: Date,
): Promise<Map<string, PagoPue>> {
  const [unoAUno, porciones] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: {
        companyId, status: "MATCHED", fecha: { gte: from, lt: to },
        invoice: { tipo: "EGRESO", metodoPago: "PUE", status: "STAMPED", fecha: { lt: from } },
      },
      select: { invoiceId: true, monto: true },
    }),
    prisma.conciliacionDetalle.findMany({
      where: {
        bankTransaction: { companyId, status: "MATCHED", fecha: { gte: from, lt: to } },
        invoice: { tipo: "EGRESO", metodoPago: "PUE", status: "STAMPED", fecha: { lt: from } },
      },
      select: { invoiceId: true, montoAsignado: true },
    }),
  ]);
  const out = new Map<string, PagoPue>();
  const suma = (id: string, monto: number) => {
    const p = out.get(id) ?? { pagadoEnPeriodo: 0, pagadoAcumulado: 0 };
    p.pagadoEnPeriodo += monto;
    p.pagadoAcumulado += monto;
    out.set(id, p);
  };
  for (const t of unoAUno) if (t.invoiceId) suma(t.invoiceId, Math.abs(Number(t.monto)));
  for (const d of porciones) suma(d.invoiceId, Math.abs(Number(d.montoAsignado)));
  return out;
}
