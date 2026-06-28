// ─────────────────────────────────────────────────────────────────────────────
// Validación ligera de un CfdiInput contra catálogos SAT, antes de mandarlo al
// PAC. Facturapi valida server-side; los PACs "delgados" (SW, Finkok) no, así
// que esta capa da errores claros y consistentes sin importar el PAC.
//
// Alcance deliberado: sólo los catálogos CHICOS y enumerables (régimen, uso,
// forma/método de pago) + formato (RFC, CP, tasas). Los catálogos ENORMES
// (c_ClaveProdServ ~50k, c_ClaveUnidad ~2.4k, c_CodigoPostal ~100k) NO se
// embeben — los valida el PAC/SAT al timbrar. Aquí sólo checamos su formato.
// ─────────────────────────────────────────────────────────────────────────────

import type { CfdiInput } from "./types";

// c_FormaPago (subconjunto vigente; "99" = por definir).
const FORMAS_PAGO = new Set([
  "01", "02", "03", "04", "05", "06", "08", "12", "13", "14", "15", "17",
  "23", "24", "25", "26", "27", "28", "29", "30", "31", "99",
]);

// c_UsoCFDI 4.0.
const USOS_CFDI = new Set([
  "G01", "G02", "G03", "I01", "I02", "I03", "I04", "I05", "I06", "I07", "I08",
  "D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08", "D09", "D10",
  "S01", "CP01", "CN01", "P01",
]);

// c_RegimenFiscal.
const REGIMENES = new Set([
  "601", "603", "605", "606", "607", "608", "610", "611", "612", "614", "615",
  "616", "620", "621", "622", "623", "624", "625", "626", "628", "629", "630",
]);

const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i;
const CP_RE = /^\d{5}$/;
const PRODSERV_RE = /^\d{8}$/; // c_ClaveProdServ: 8 dígitos (sólo formato)

/** Devuelve la lista de errores (vacía = válido). PURO y testeable. */
export function validarCfdiInput(input: CfdiInput): string[] {
  const errs: string[] = [];

  if (!FORMAS_PAGO.has(input.paymentForm)) {
    errs.push(`Forma de pago inválida: "${input.paymentForm}" (c_FormaPago).`);
  }
  if (input.paymentMethod !== "PUE" && input.paymentMethod !== "PPD") {
    errs.push(`Método de pago inválido: "${input.paymentMethod}" (debe ser PUE o PPD).`);
  }
  if (!USOS_CFDI.has(input.use)) {
    errs.push(`Uso de CFDI inválido: "${input.use}" (c_UsoCFDI).`);
  }

  // Receptor (cuando viene en línea, como lo requiere SW).
  if (input.receptor) {
    const r = input.receptor;
    if (!RFC_RE.test(r.rfc)) errs.push(`RFC del receptor con formato inválido: "${r.rfc}".`);
    if (!r.nombre?.trim()) errs.push("Falta el nombre/razón social del receptor.");
    if (!REGIMENES.has(r.regimenFiscal)) {
      errs.push(`Régimen fiscal del receptor inválido: "${r.regimenFiscal}" (c_RegimenFiscal).`);
    }
    if (!CP_RE.test(r.domicilioFiscalCP)) {
      errs.push(`Código postal del receptor inválido: "${r.domicilioFiscalCP}" (5 dígitos).`);
    }
  }

  if (!input.items?.length) {
    errs.push("El CFDI no tiene conceptos.");
  }
  for (const [i, it] of (input.items ?? []).entries()) {
    if (!PRODSERV_RE.test(it.product.product_key)) {
      errs.push(`Concepto ${i + 1}: ClaveProdServ con formato inválido: "${it.product.product_key}" (8 dígitos).`);
    }
    if (!(it.quantity > 0)) errs.push(`Concepto ${i + 1}: cantidad debe ser > 0.`);
    if (!(it.product.price >= 0)) errs.push(`Concepto ${i + 1}: valor unitario inválido.`);
  }

  return errs;
}
