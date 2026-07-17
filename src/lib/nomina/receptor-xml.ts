// ─────────────────────────────────────────────────────────────────────────────
// Identidad fiscal del RECEPTOR desde un CFDI de nómina previo. Un recibo
// timbrado (p. ej. los importados del SAT) ya pasó la validación de la
// tripleta RFC + Nombre + DomicilioFiscalReceptor del CFDI 4.0 — sus atributos
// son, por definición, los datos EXACTOS registrados en el SAT para ese
// empleado. Se usan como respaldo al timbrar cuando la ficha del empleado no
// tiene capturado el CP fiscal (o para usar el nombre textual registrado en
// vez de reconstruirlo de nombre+apellidos, que truena por acentos/espacios).
// Helper puro (regex sobre atributos planos), convención del repo.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReceptorFiscal {
  nombre: string | null;
  codigoPostal: string | null;
}

/**
 * Extrae Nombre y DomicilioFiscalReceptor del nodo Receptor de un CFDI,
 * verificando que el Rfc del nodo sea el esperado (el XML podría ser de otro
 * empleado si el llamador filtró mal). Null si no hay nodo o el RFC no cuadra.
 */
/**
 * Extrae el RegistroPatronal del complemento de nómina de un recibo timbrado
 * (nodo nomina12:Emisor — el ÚNICO lugar del CFDI donde aparece ese atributo,
 * así que el regex por atributo es inequívoco). Un recibo importado del SAT lo
 * trae validado por el PAC: es el registro patronal real del emisor. Null si
 * no está o viene vacío.
 */
export function registroPatronalDesdeXmlNomina(rawXml: string): string | null {
  const m = rawXml.match(/\sRegistroPatronal\s*=\s*"([^"]+)"/i);
  const rp = m?.[1].trim();
  return rp || null;
}

export function receptorDesdeXmlNomina(rawXml: string, rfcEsperado: string): ReceptorFiscal | null {
  const m = rawXml.match(/<(?:[\w-]+:)?Receptor\b[^>]*>/i);
  if (!m) return null;
  const nodo = m[0];
  const attr = (name: string): string | null => {
    const a = nodo.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i"));
    return a ? a[1] : null;
  };
  const rfc = attr("Rfc");
  if (!rfc || rfc.trim().toUpperCase() !== rfcEsperado.trim().toUpperCase()) return null;
  const cp = attr("DomicilioFiscalReceptor");
  return {
    nombre: attr("Nombre"),
    codigoPostal: cp && /^\d{5}$/.test(cp) ? cp : null,
  };
}
