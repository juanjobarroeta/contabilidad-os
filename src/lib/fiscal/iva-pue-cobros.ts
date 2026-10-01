// Ordinary outgoing PUE IVA follows collection (LIVA 1-B, 11, 17, 22),
// independently of invoice generation/certification. No writes or tax guesses.
// Interest classification is reviewed separately (LIVA 15-X / 18-A).
export interface PueTax {
  tipo: string;
  factor: string;
  tasa: number;
  base: number | null;
  importe: number;
  retencion: boolean;
}
export interface PueIncome {
  id: string;
  fecha: Date;
  total: number;
  subtotal: number;
  descuento: number;
  moneda: string;
  formaPago: string;
  ivaNoCausado: boolean;
  taxes: PueTax[];
  items: { claveProdServ: string; descripcion: string }[];
}
export interface PueCollection {
  id: string;
  fecha: Date;
  monto: number;
  referencia: string;
}
export interface PueTimingReview {
  version: 1;
  tratamiento: "FLUJO_GENERAL" | "REVISION_ESPECIAL";
  fechaCobro: string | null;
  evidencia: string | null;
  motivo: string;
  fingerprint: string;
  actorId: string;
  reviewedAt: string;
}
export interface PueCollectionResult {
  invoiceId: string;
  fechaCfdi: string;
  fechasCobro: string[];
  fuente:
    | "BANCO_CONCILIADO"
    | "COBRO_DOCUMENTADO"
    | "SIN_EVIDENCIA"
    | "EXCLUIDO";
  cobradoEnPeriodo: number;
  fraccion: number;
  trasladado: number;
  retenido: number;
  gravados: number;
  exentos: number;
  determinado: boolean;
  incidencias: string[];
  evidencia: { id: string; fecha: string; monto: number; referencia: string }[];
}

const cents = (n: number) => Math.round(n * 100);
const money = (n: number) => n / 100;
export const pueDay = (d: Date) => d.toISOString().slice(0, 10);

export function requiresInterestReview(
  invoice: Pick<PueIncome, "items">,
): boolean {
  // A signal for review, NEVER a determination of exemption or rate.
  return invoice.items.some(
    (i) =>
      /^8412/.test(i.claveProdServ) ||
      /\b(inter[eé]s(?:es)?|mutuo|financiamiento|arrendamiento financiero|factoraje)\b/i.test(
        i.descripcion,
      ),
  );
}

export function calculatePueCollections(
  invoice: PueIncome,
  collections: PueCollection[],
  from: Date,
  to: Date,
  review: PueTimingReview | null = null,
  evidenceIssues: string[] = [],
): PueCollectionResult {
  const incidencias = [...evidenceIssues];
  if (
    requiresInterestReview(invoice) &&
    review?.tratamiento !== "FLUJO_GENERAL"
  ) {
    incidencias.push(
      "Confirma el tratamiento de los intereses: exenciones del Art. 15-X y regla especial del Art. 18-A LIVA. La clave SAT no decide el tratamiento.",
    );
  }
  if (review?.tratamiento === "REVISION_ESPECIAL")
    incidencias.push(
      "Tratamiento especial pendiente: este motor no determina el IVA de intereses del Art. 18-A ni cambia la tasa del CFDI.",
    );
  if (invoice.moneda !== "MXN")
    incidencias.push(
      "Cobro en moneda extranjera: falta revisar la conversión y la fecha fiscal.",
    );
  const valid = collections.filter(
    (c) =>
      Number.isFinite(c.monto) &&
      cents(c.monto) > 0 &&
      Number.isFinite(c.fecha.getTime()),
  );
  if (valid.length !== collections.length)
    incidencias.push(
      "Hay una aplicación bancaria con fecha o importe inválido.",
    );
  let receipts = [...new Map(valid.map((c) => [c.id, c])).values()];
  let fuente: PueCollectionResult["fuente"] = receipts.length
    ? "BANCO_CONCILIADO"
    : "SIN_EVIDENCIA";
  if (review?.fechaCobro) {
    const date = new Date(`${review.fechaCobro}T00:00:00.000Z`);
    // A manual full-payment attestation is an alternative source, not another payment.
    if (
      receipts.length &&
      (receipts.some((r) => pueDay(r.fecha) !== review.fechaCobro) ||
        receipts.reduce((s, r) => s + cents(r.monto), 0) !==
          cents(invoice.total))
    ) {
      incidencias.push(
        "El cobro documentado no coincide con las aplicaciones del banco. Revisa la conciliación; no se sumaron dos fuentes del mismo pago.",
      );
    } else if (!receipts.length) {
      receipts = [
        {
          id: "documentado:" + invoice.id,
          fecha: date,
          monto: invoice.total,
          referencia: review.evidencia ?? "",
        },
      ];
      fuente = "COBRO_DOCUMENTADO";
    }
  }
  receipts.sort(
    (a, b) => a.fecha.getTime() - b.fecha.getTime() || a.id.localeCompare(b.id),
  );
  const total = cents(invoice.total);
  const paid = receipts.reduce((s, r) => s + cents(r.monto), 0);
  if (receipts.length && paid > total + 1)
    incidencias.push(
      "Los cobros exceden el CFDI: revisa duplicados, comisiones o aplicaciones. El cálculo está limitado al total y no es definitivo.",
    );
  if (receipts.length && paid < total - 1)
    incidencias.push(
      "PUE con cobro incompleto: confirma los pagos faltantes y revisa si corresponde corregir el método de pago.",
    );
  if (
    receipts.some(
      (r) => pueDay(r.fecha).slice(0, 7) > pueDay(invoice.fecha).slice(0, 7),
    )
  ) {
    incidencias.push(
      "PUE cobrado en un mes posterior a su emisión: revisa la corrección del CFDI; el IVA sigue la fecha efectiva de cobro.",
    );
  }
  if (!receipts.length && !invoice.ivaNoCausado)
    incidencias.push(
      "Falta evidencia de cobro. La cifra por fecha del CFDI es una estimación, no IVA determinado; concilia o documenta el cobro.",
    );
  if (total <= 0)
    incidencias.push(
      "El total del CFDI debe ser positivo para aplicar el cobro.",
    );
  const ivaTaxes = invoice.taxes.filter(
    (t) => t.tipo === "IVA" && !t.retencion,
  );
  if (!ivaTaxes.length && !invoice.ivaNoCausado)
    incidencias.push(
      "Falta el desglose de IVA del CFDI: no se presume una tasa ni una exención.",
    );
  if (
    ivaTaxes.some(
      (t) =>
        !["TASA", "EXENTO"].includes(t.factor) ||
        !Number.isFinite(t.importe) ||
        t.importe < 0,
    ) ||
    (ivaTaxes.some((t) => t.base !== null) &&
      ivaTaxes.some((t) => t.base === null))
  ) {
    incidencias.push(
      "Desglose de IVA incompleto o inconsistente: revisa bases e impuestos del CFDI antes de determinar el periodo.",
    );
  }
  const suma = (before: Date) =>
    Math.min(
      Math.max(0, total),
      receipts
        .filter((r) => r.fecha < before)
        .reduce((s, r) => s + cents(r.monto), 0),
    );
  let before = suma(from),
    through = suma(to);
  if (!receipts.length && invoice.fecha >= from && invoice.fecha < to) {
    before = 0;
    through = Math.max(0, total);
  }
  if (invoice.ivaNoCausado) {
    if (receipts.length)
      incidencias.push(
        "El CFDI está marcado no cobrado pero tiene evidencia de cobro; resuelve la contradicción antes de determinar el IVA.",
      );
    before = through = 0;
    fuente = "EXCLUIDO";
  }
  // Difference of cumulative rounded amounts conserves cents across months.
  const allocate = (amount: number) =>
    total > 0
      ? money(
          Math.round((cents(amount) * through) / total) -
            Math.round((cents(amount) * before) / total),
        )
      : 0;
  const taxes = (retencion: boolean) =>
    invoice.taxes
      .filter((t) => t.tipo === "IVA" && t.retencion === retencion)
      .reduce((s, t) => s + t.importe, 0);
  const withBase = ivaTaxes.filter((t) => t.base !== null);
  const gravados = withBase.length
    ? withBase
        .filter((t) => t.factor !== "EXENTO")
        .reduce((s, t) => s + t.base!, 0)
    : ivaTaxes.length && !ivaTaxes.every((t) => t.factor === "EXENTO")
      ? invoice.subtotal - invoice.descuento
      : 0;
  const exentos = withBase.length
    ? withBase
        .filter((t) => t.factor === "EXENTO")
        .reduce((s, t) => s + t.base!, 0)
    : ivaTaxes.length && ivaTaxes.every((t) => t.factor === "EXENTO")
      ? invoice.subtotal - invoice.descuento
      : 0;
  return {
    invoiceId: invoice.id,
    fechaCfdi: pueDay(invoice.fecha),
    fechasCobro: [...new Set(receipts.map((r) => pueDay(r.fecha)))],
    fuente,
    cobradoEnPeriodo: receipts.length ? money(through - before) : 0,
    fraccion: total > 0 ? (through - before) / total : 0,
    trasladado: allocate(taxes(false)),
    retenido: allocate(taxes(true)),
    gravados: allocate(gravados),
    exentos: allocate(exentos),
    determinado: incidencias.length === 0,
    incidencias: [...new Set(incidencias)],
    evidencia: receipts.map((r) => ({ ...r, fecha: pueDay(r.fecha) })),
  };
}
