import { DOMParser, type Element } from "@xmldom/xmldom";
import { decimalToSafeMicros, type RegimenPaymentEvidence } from "./regimen-document-bases";

export const REP_CHECK_VERSION = "2026-10-01.1";
export const REP_XML_MAX_BYTES = 256 * 1024;
export const REP_CHECK_REASONS = {
  XML_MISSING: "No se conserva el XML del REP. No se infiere la forma de pago del CFDI padre.",
  XML_LIMIT: "El cotejo excede el límite de lectura; requiere revisión del expediente.",
  XML_INVALID: "El XML no tiene una estructura válida y segura para este cotejo.",
  VERSION_REVIEW: "Este cotejo sólo cubre CFDI 4.0 con complemento de pagos 2.0.",
  REP_NOT_CURRENT: "El REP está cancelado, sustituido o sin timbrar en los registros de la aplicación.",
  IDENTITY_MISMATCH: "El UUID o los RFC del REP no coinciden con la empresa y el proveedor del CFDI.",
  SUPPLIER_MISSING: "Falta el RFC del proveedor para cotejar la identidad del REP.",
  RELATION_MISSING: "El XML no contiene la relación con este CFDI.",
  RELATION_AMBIGUOUS: "El XML contiene más de un pago para este CFDI; la relación almacenada no los distingue.",
  PAYMENT_MISMATCH: "La fecha, parcialidad o importe almacenado no coincide exactamente con el XML.",
  PAYMENT_METHOD_REVIEW: "La forma de pago del REP falta o requiere revisión; no se sustituye por la del CFDI padre.",
  CURRENCY_REVIEW: "Las monedas o equivalencias requieren revisión; el cotejo no convierte divisas.",
  AMOUNT_REVIEW: "Los importes o saldos del REP no son consistentes para este cotejo.",
} as const;
export type RepCheckReason = keyof typeof REP_CHECK_REASONS;
const CFDI = "http://www.sat.gob.mx/cfd/4";
const PAGOS = "http://www.sat.gob.mx/Pagos20";
const TIMBRE = "http://www.sat.gob.mx/TimbreFiscalDigital";
const uuid = (value: string | null | undefined) => value?.trim().toUpperCase() ?? "";
const attr = (element: Element, key: string) => element.getAttribute(key)?.trim() || null;
function children(element: Element, namespace: string, name: string): Element[] {
  return Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1
    && node.namespaceURI === namespace && node.localName === name);
}
function one(element: Element, namespace: string, name: string): Element {
  const found = children(element, namespace, name);
  if (found.length !== 1) throw new Error("Ambiguous XML structure");
  return found[0];
}

type ParsedPayment = {
  parentUuid: string; fechaPago: string | null; formaDePagoP: string | null;
  monedaP: string | null; monedaDR: string | null; equivalenciaDR: string | null; tipoCambioP: string | null;
  parcialidad: string | null; impPagado: string | null; saldoAnterior: string | null; saldoInsoluto: string | null;
  monto: string | null; groupAmounts: (number | null)[]; groupSameCurrency: boolean;
};
export type ParsedRep = { ok: false; reason: RepCheckReason } | {
  ok: true; repUuid: string; emisorRfc: string; receptorRfc: string; payments: ParsedPayment[];
};

/** Local source comparison only: no network, DTD/entities, seal or SAT validation. */
export function parseRepPaymentEvidence(xml: string | null): ParsedRep {
  if (!xml?.trim()) return { ok: false, reason: "XML_MISSING" };
  if (Buffer.byteLength(xml, "utf8") > REP_XML_MAX_BYTES) return { ok: false, reason: "XML_LIMIT" };
  // Reject declarations before parsing. Never resolve arbitrary entities or URLs.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || (xml.match(/</g)?.length ?? 0) > 10_000) return { ok: false, reason: "XML_INVALID" };
  try {
    const doc = new DOMParser({ onError: () => { throw new Error("Invalid XML"); } }).parseFromString(xml, "text/xml");
    const root = doc.documentElement;
    if (!root || root.namespaceURI !== CFDI || root.localName !== "Comprobante" || attr(root, "Version") !== "4.0") {
      return { ok: false, reason: "VERSION_REVIEW" };
    }
    if (attr(root, "TipoDeComprobante") !== "P") return { ok: false, reason: "XML_INVALID" };
    const complement = one(root, CFDI, "Complemento");
    const pagos = one(complement, PAGOS, "Pagos");
    if (attr(pagos, "Version") !== "2.0") return { ok: false, reason: "VERSION_REVIEW" };
    const payments: ParsedPayment[] = [];
    for (const pago of children(pagos, PAGOS, "Pago")) {
      const related = children(pago, PAGOS, "DoctoRelacionado");
      if (!related.length) return { ok: false, reason: "XML_INVALID" };
      const groupAmounts = related.map((d) => decimalToSafeMicros(attr(d, "ImpPagado")));
      const groupSameCurrency = related.every((d) => attr(d, "MonedaDR") === "MXN"
        && (attr(d, "EquivalenciaDR") === null || /^1(?:\.0{1,10})?$/.test(attr(d, "EquivalenciaDR")!)));
      for (const d of related) payments.push({
        parentUuid: uuid(attr(d, "IdDocumento")), fechaPago: attr(pago, "FechaPago"), formaDePagoP: attr(pago, "FormaDePagoP"),
        monedaP: attr(pago, "MonedaP"), monedaDR: attr(d, "MonedaDR"), equivalenciaDR: attr(d, "EquivalenciaDR"), tipoCambioP: attr(pago, "TipoCambioP"),
        parcialidad: attr(d, "NumParcialidad"), impPagado: attr(d, "ImpPagado"), saldoAnterior: attr(d, "ImpSaldoAnt"), saldoInsoluto: attr(d, "ImpSaldoInsoluto"),
        monto: attr(pago, "Monto"), groupAmounts, groupSameCurrency,
      });
    }
    if (!payments.length || payments.length > 1000) return { ok: false, reason: "XML_LIMIT" };
    return { ok: true, repUuid: uuid(attr(one(complement, TIMBRE, "TimbreFiscalDigital"), "UUID")),
      emisorRfc: uuid(attr(one(root, CFDI, "Emisor"), "Rfc")), receptorRfc: uuid(attr(one(root, CFDI, "Receptor"), "Rfc")), payments };
  } catch { return { ok: false, reason: "XML_INVALID" }; }
}

export type RepPaymentCheck = { estado: "PENDIENTE"; motivo: RepCheckReason } | {
  estado: "COTEJADO"; motivo: null; fechaPago: string; formaDePagoP: string; monedaP: "MXN"; monedaDR: "MXN";
  impPagado: string; parcialidad: number;
};
const pending = (motivo: RepCheckReason): RepPaymentCheck => ({ estado: "PENDIENTE", motivo });

/** Compare naive CFDI calendar time with our canonical UTC storage, never host TZ. */
export function repCalendarIso(value: string | null): string | null {
  if (!value || !/^20\d{2}-(0[1-9]|1[0-2])-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const time = new Date(`${value}Z`);
  return Number.isFinite(time.valueOf()) && time.toISOString().slice(0, 19) === value ? time.toISOString() : null;
}

export function compareRepPayment(parsed: ParsedRep, payment: RegimenPaymentEvidence,
  companyRfc: string, supplierRfc: string | null): RepPaymentCheck {
  if (payment.status !== "STAMPED" || payment.supersededBy) return pending("REP_NOT_CURRENT");
  if (!parsed.ok) return pending(parsed.reason);
  if (!supplierRfc?.trim()) return pending("SUPPLIER_MISSING");
  if (!/^[\dA-F]{8}(-[\dA-F]{4}){3}-[\dA-F]{12}$/.test(uuid(payment.repUuid))
    || !/^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/.test(uuid(companyRfc))
    || !/^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/.test(uuid(supplierRfc)) || parsed.repUuid !== uuid(payment.repUuid)
    || parsed.receptorRfc !== uuid(companyRfc) || parsed.emisorRfc !== uuid(supplierRfc)) return pending("IDENTITY_MISMATCH");
  const matches = parsed.payments.filter((row) => row.parentUuid === uuid(payment.parentUuid));
  if (!matches.length) return pending("RELATION_MISSING");
  if (matches.length !== 1) return pending("RELATION_AMBIGUOUS");
  const source = matches[0], date = repCalendarIso(source.fechaPago);
  const paid = decimalToSafeMicros(source.impPagado);
  if (!date || date !== payment.fechaPago || !/^[1-9]\d{0,2}$/.test(source.parcialidad ?? "")
    || Number(source.parcialidad) !== payment.installment || paid === null || paid !== payment.amountMicros) return pending("PAYMENT_MISMATCH");
  // These are source codes, NOT an allowed-deduction/payment-method whitelist.
  if (!/^(01|02|03|04|05|06|08|12|13|14|15|17|23|24|25|26|27|28|29|30|31)$/.test(source.formaDePagoP ?? "")) return pending("PAYMENT_METHOD_REVIEW");
  if (source.monedaP !== "MXN" || source.monedaDR !== "MXN" || !source.groupSameCurrency
    || (source.tipoCambioP !== null && !/^1(?:\.0{1,6})?$/.test(source.tipoCambioP))) return pending("CURRENCY_REVIEW");
  const before = decimalToSafeMicros(source.saldoAnterior), after = decimalToSafeMicros(source.saldoInsoluto), total = decimalToSafeMicros(source.monto);
  if (paid <= 0 || before === null || after === null || total === null || before <= 0 || total <= 0
    || BigInt(before) - BigInt(paid) !== BigInt(after) || source.groupAmounts.some((amount) => amount === null || amount <= 0)
    || source.groupAmounts.reduce<bigint>((sum, amount) => sum + BigInt(amount ?? 0), BigInt(0)) > BigInt(total)) return pending("AMOUNT_REVIEW");
  return { estado: "COTEJADO", motivo: null, fechaPago: source.fechaPago!, formaDePagoP: source.formaDePagoP!,
    monedaP: "MXN", monedaDR: "MXN", impPagado: source.impPagado!, parcialidad: Number(source.parcialidad) };
}
