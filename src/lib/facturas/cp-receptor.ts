// ─────────────────────────────────────────────────────────────────────────────
// CP fiscal del receptor desde el propio CFDI.
//
// CFDI 4.0 exige DomicilioFiscalReceptor (el CP del padrón) en todo
// comprobante emitido: para cualquier cliente al que ya se le facturó, el CP
// vive en nuestro rawXml. Extraerlo mata el último paso manual antes de
// timbrar (decisión del owner, revisión pág. 6): el usuario no captura lo que
// el SAT ya nos dijo.
// ─────────────────────────────────────────────────────────────────────────────

/** CP de 5 dígitos del atributo DomicilioFiscalReceptor, o null. */
export function cpReceptorDesdeXml(xml: string | null | undefined): string | null {
  if (!xml) return null;
  const m = /\bDomicilioFiscalReceptor="([0-9]{5})"/.exec(xml);
  return m?.[1] ?? null;
}
