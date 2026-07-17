// ─────────────────────────────────────────────────────────────────────────────
// Nombre fiscal EXACTO del emisor para CFDI 4.0. El SAT valida que el Nombre
// del Emisor coincida con el registrado para su RFC — y desde CFDI 4.0 ese
// nombre registrado NO incluye el régimen societario ("SA DE CV", "S.A.P.I.
// DE C.V.", …). Mandar la razón social con sufijo truena el timbrado con
// "El campo Nombre del emisor, debe pertenecer al nombre asociado al RFC".
//
// Dos vías, en orden de confianza:
//   1. emisorNombreDesdeXml(): el Nombre del nodo Emisor de un CFDI TIMBRADO
//      del propio RFC (p.ej. una factura importada del SAT) — validado por el
//      SAT al timbrarse, es el nombre EXACTO del padrón.
//   2. sinRegimenSocietario(): recorte del sufijo societario de la razón
//      social capturada, como respaldo cuando no hay XML del emisor.
// Helpers puros (regex sobre atributos planos), convención del repo.
// ─────────────────────────────────────────────────────────────────────────────

/** Entidades XML básicas que pueden aparecer en un Nombre ("&" es común). */
function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Nombre del nodo Emisor de un CFDI, verificando que el Rfc del nodo sea el
 * esperado (el XML podría ser un CFDI recibido, donde el emisor es otro).
 * Null si no hay nodo, el RFC no cuadra o el atributo viene vacío.
 */
export function emisorNombreDesdeXml(rawXml: string, rfcEsperado: string): string | null {
  const m = rawXml.match(/<(?:[\w-]+:)?Emisor\b[^>]*>/i);
  if (!m) return null;
  const nodo = m[0];
  const attr = (name: string): string | null => {
    const a = nodo.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i"));
    return a ? a[1] : null;
  };
  const rfc = attr("Rfc");
  if (!rfc || rfc.trim().toUpperCase() !== rfcEsperado.trim().toUpperCase()) return null;
  const nombre = attr("Nombre");
  const limpio = nombre ? decodeXml(nombre).trim() : "";
  return limpio || null;
}

// Sufijos societarios que el padrón del SAT NO incluye en el nombre. Se
// comparan sobre una forma normalizada (sin puntos/comas, espacios simples,
// MAYÚSCULAS) para tolerar "S.A. de C.V.", "SA DE CV", ", S. DE R.L. DE
// C.V.", etc. Orden: del más largo al más corto para que "SA DE CV" no corte
// antes que "SAPI DE CV".
const SUFIJOS_SOCIETARIOS = [
  "SAPI DE CV",
  "SAB DE CV",
  "SAS DE CV",
  "S DE RL DE CV",
  "SA DE CV",
  "S DE RL",
  "S EN C",
  "SNC",
  "SAPI",
  "SAS",
  "SA",
  "SC",
  "AC",
];

/** Forma normalizada para comparar: puntos FUERA ("S.A." → "SA"), comas a
 *  espacio, espacios simples, MAYÚSCULAS. */
function normalizar(s: string): string {
  return s.replace(/\./g, "").replace(/,/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
}

/**
 * Razón social SIN el régimen societario final ("REYES HUERTA CHOLULA SA DE
 * CV" → "REYES HUERTA CHOLULA"). Si no hay sufijo reconocido (personas
 * físicas, nombres ya limpios), regresa la cadena original recortada. Nunca
 * deja el nombre vacío (un nombre que ES sólo el sufijo se regresa intacto).
 */
export function sinRegimenSocietario(razonSocial: string): string {
  const original = razonSocial.trim();
  const norm = normalizar(original);
  for (const sufijo of SUFIJOS_SOCIETARIOS) {
    if (norm === sufijo) return original; // el nombre completo ES el sufijo
    if (!norm.endsWith(" " + sufijo)) continue;
    // Recortar el ORIGINAL: quitar tantas palabras del final como tenga el
    // sufijo (las comas/puntos pegados a esas palabras se van con ellas).
    const palabrasSufijo = sufijo.split(" ").length;
    const palabras = original.split(/\s+/);
    let porQuitar = palabrasSufijo;
    let corte = palabras.length;
    // Las palabras del sufijo pueden venir partidas distinto en el original
    // ("S.A.P.I." es UNA palabra que normaliza a "S A P I" = 4 tokens), así
    // que se quita palabra por palabra del final hasta cubrir el sufijo.
    while (corte > 0 && porQuitar > 0) {
      corte--;
      const tokens = normalizar(palabras[corte]).split(" ").filter(Boolean).length;
      porQuitar -= tokens;
    }
    if (porQuitar !== 0) continue; // partición rara: no coincide palabra a palabra
    const recortado = palabras.slice(0, corte).join(" ").replace(/[\s,]+$/, "").trim();
    return recortado || original;
  }
  return original;
}
