// ─────────────────────────────────────────────────────────────────────────────
// Lectura de la Opinión del cumplimiento de obligaciones fiscales (Art. 32-D
// CFF) a partir del texto del PDF que emite el SAT. El documento trae «Folio»,
// «Fecha de emisión» (o «Fecha»), el «Sentido» (POSITIVO / NEGATIVO / INSCRITO
// SIN OBLIGACIONES / NO INSCRITO…) y, cuando es negativa, el detalle de las
// obligaciones omitidas o créditos. Sin modelos: patrones sobre el texto, del
// más firme (el renglón «Sentido») al más laxo (frases del cuerpo). Si nada
// casa, ERROR con aviso — el PDF se guarda igual para leerlo a mano.
// Vigencia: 30 días naturales desde la emisión (regla 2.1.37 RMF), salvo que
// el propio documento imprima otra.
// ─────────────────────────────────────────────────────────────────────────────

import type { OpinionResult, ResultadoOpinion } from "../types";

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

/** Vigencia de la opinión 32-D: 30 días naturales desde su emisión (regla 2.1.37 RMF). */
export const VIGENCIA_DIAS_SAT = 30;

const normalizar = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

/** «13 de septiembre de 2026» / «13/09/2026» / «2026-09-13» → ISO (YYYY-MM-DD), o null. */
export function fechaIsoDe(frag: string): string | null {
  const t = normalizar(frag).toLowerCase();
  const m1 = t.match(/(\d{1,2})\s+de\s+([a-z]+)\s+(?:de\s+|del\s+)?(\d{4})/);
  if (m1 && MESES[m1[2]]) return `${m1[3]}-${String(MESES[m1[2]]).padStart(2, "0")}-${m1[1].padStart(2, "0")}`;
  const m2 = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2, "0")}-${m2[1].padStart(2, "0")}`;
  const m3 = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m3) return `${m3[1]}-${m3[2]}-${m3[3]}`;
  return null;
}

/** Campo de la cadena original («|Clave:valor|»), si el PDF la trae. */
function campoCadena(texto: string, clave: string): string | null {
  const m = normalizar(texto).match(new RegExp(`\\|${clave}\\s*:\\s*([^|]*)`, "i"));
  return m ? m[1].trim() : null;
}

/**
 * La cadena original FIRMADA del 32-D, visto en vivo (BARTIZ, 22-sep-2026):
 * «||CBA170606FQ8|26NL1324942|22-09-2026|P||00001088888800000031||» =
 * RFC | folio | fecha dd-mm-yyyy | sentido (P positivo, N negativo). Es la
 * fuente más firme: el resto del PDF es una tabla cuyo texto extraído
 * intercala encabezados y valores («RFC Folio» / «CBA… 26NL…»).
 */
export function cadenaOriginalSat(texto: string): { rfc: string; folio: string; fecha: string | null; sentido: string } | null {
  const m = normalizar(texto).match(/\|\|([A-Z&Ñ0-9]{12,13})\|([A-Z0-9]{6,})\|(\d{2}-\d{2}-\d{4})\|([A-Z])\|\|/i);
  if (!m) return null;
  const [d, mo, y] = m[3].split("-");
  return { rfc: m[1].toUpperCase(), folio: m[2].toUpperCase(), fecha: `${y}-${mo}-${d}`, sentido: m[4].toUpperCase() };
}

const sentidoDe = (v: string): ResultadoOpinion | null => {
  const u = normalizar(v).toUpperCase();
  if (/^POSITIV/.test(u)) return "POSITIVA";
  if (/^NEGATIV/.test(u)) return "NEGATIVA";
  if (/^INSCRITO\s+SIN\s+OBLIGACIONES|^SIN\s+OBLIGACIONES/.test(u)) return "SIN_OBLIGACIONES";
  if (/^NO\s+INSCRITO|^NO\s+LOCALIZAD|^SUSPENDID|^CANCELAD/.test(u)) return "NO_LOCALIZADO";
  return null;
};

/** Sentido de la opinión leído del texto. */
export function sentidoSat(texto: string): ResultadoOpinion {
  // 1. Cadena original firmada: ||RFC|folio|fecha|P||  (P/N) o |Sentido:POSITIVO|
  const cadena = cadenaOriginalSat(texto);
  if (cadena?.sentido === "P") return "POSITIVA";
  if (cadena?.sentido === "N") return "NEGATIVA";
  const c = campoCadena(texto, "Sentido");
  if (c) { const r = sentidoDe(c); if (r) return r; }
  const t = normalizar(texto).toUpperCase();
  // 2. El renglón «Sentido: POSITIVO» / «Sentido de la opinión: NEGATIVO».
  const m = t.match(/SENTIDO(?:\s+DE\s+LA\s+OPINION)?\s*[:.]?\s*(POSITIV[OA]|NEGATIV[OA]|INSCRITO\s+SIN\s+OBLIGACIONES|SIN\s+OBLIGACIONES|NO\s+INSCRITO|NO\s+LOCALIZAD[OA]|SUSPENDID[OA]|CANCELAD[OA])/);
  if (m) return sentidoDe(m[1]) ?? "ERROR";
  // 3. Frases del cuerpo. La negativa se prueba antes: «NO se encuentra al corriente».
  if (/NO\s+SE\s+ENCUENTRA\s+AL\s+CORRIENTE|NO\s+ESTA\s+AL\s+CORRIENTE|OPINION\s+(DE\s+CUMPLIMIENTO\s+)?NEGATIVA/.test(t)) return "NEGATIVA";
  if (/SE\s+ENCUENTRA\s+AL\s+CORRIENTE|ESTA\s+AL\s+CORRIENTE|OPINION\s+(DE\s+CUMPLIMIENTO\s+)?POSITIVA/.test(t)) return "POSITIVA";
  if (/INSCRITO\s+SIN\s+OBLIGACIONES|SIN\s+OBLIGACIONES\s+FISCALES/.test(t)) return "SIN_OBLIGACIONES";
  if (/NO\s+SE\s+ENCUENTRA\s+INSCRITO|NO\s+ESTA\s+INSCRITO|NO\s+LOCALIZAD|SUSPENSION\s+DE\s+ACTIVIDADES|CANCELACION\s+EN\s+EL\s+RFC/.test(t)) return "NO_LOCALIZADO";
  return "ERROR";
}

/** Folio de la opinión (p.ej. «26NE1234567»), o null. */
export function folioSat(texto: string): string | null {
  const cadena = cadenaOriginalSat(texto);
  if (cadena) return cadena.folio;
  const c = campoCadena(texto, "Folio");
  if (c && /^[A-Z0-9-]{6,}$/i.test(c)) return c.toUpperCase();
  // Forma del folio del 32-D: «26NL1324942» (2 dígitos, 2 letras, 7 dígitos).
  // En la tabla del PDF «Folio» queda en un renglón y el valor en el siguiente,
  // junto al RFC, así que no vale «lo que siga a la palabra Folio».
  const t = normalizar(texto).toUpperCase();
  const forma = t.match(/\b(\d{2}[A-Z]{2}\d{7})\b/);
  if (forma) return forma[1];
  const m = t.match(/FOLIO\s*(?:DE\s+LA\s+OPINION)?\s*[:.]?\s*([A-Z0-9][A-Z0-9-]{5,})/);
  return m && !/^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/.test(m[1]) ? m[1] : null;
}

/** Fecha de emisión en ISO, si el documento la imprime. */
export function fechaEmisionSat(texto: string): string | null {
  const cadena = cadenaOriginalSat(texto);
  if (cadena?.fecha) return cadena.fecha;
  for (const clave of ["FechaEmision", "Fecha de emision", "Fecha"]) {
    const c = campoCadena(texto, clave);
    if (c) { const f = fechaIsoDe(c); if (f) return f; }
  }
  const t = normalizar(texto);
  const m = t.match(/fecha\s+(?:y\s+hora\s+)?de\s+(?:emision|expedicion|consulta)\s*[:.]?\s*([^\n]{6,40})/i);
  if (m) { const f = fechaIsoDe(m[1]); if (f) return f; }
  const m2 = t.match(/(?:emitida?|expedida?)\s+(?:el|en)\s+(?:la\s+ciudad\s+de\s+[^,]+,\s*)?(?:el\s+)?([^\n.]{6,40})/i);
  if (m2) { const f = fechaIsoDe(m2[1]); if (f) return f; }
  return fechaIsoDe(t.slice(0, 2000)); // primera fecha del encabezado, si la hay
}

/** Fin de vigencia impreso («vigencia hasta el …» / «vigente hasta …»), o null. */
export function vigenciaSat(texto: string): string | null {
  const c = campoCadena(texto, "FechaFinVigencia") ?? campoCadena(texto, "Vigencia");
  if (c) { const f = fechaIsoDe(c); if (f) return f; }
  const m = normalizar(texto).match(/vigen(?:cia|te)\s+hasta\s+(?:el\s+)?([^,.\n]+)/i);
  return m ? fechaIsoDe(m[1]) : null;
}

/** En la negativa: renglones que nombran obligaciones omitidas, créditos o declaraciones no presentadas (hasta 10). */
export function motivosSat(texto: string): string[] {
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const raw of texto.split(/\r?\n/)) {
    const l = raw.replace(/\s+/g, " ").trim();
    if (l.length <= 8 || l.length >= 220) continue;
    if (!/omitid|omisi[oó]n|adeud|cr[eé]dito|no\s+presentad|no\s+ha\s+presentado|declaraci[oó]n\s+(anual|mensual|provisional|definitiva)|periodo\s+\d|ejercicio\s+\d{4}/i.test(l)) continue;
    if (/se\s+encuentra\s+al\s+corriente|para\s+efectos\s+de|fundamento|art[ií]culo\s+32/i.test(l)) continue;
    const k = normalizar(l).toLowerCase();
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push(l);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * Texto del PDF → OpinionResult (SAT_OPINION). El folio va primero en motivos
 * como «Folio SAT: …» — es lo que la pantalla de cumplimiento lee. Los bytes
 * del PDF los adjunta quien los tiene.
 */
export function interpretarOpinionSat(texto: string, ahora = new Date()): OpinionResult {
  const resultado = sentidoSat(texto);
  const emision = fechaEmisionSat(texto);
  const base = emision ? new Date(`${emision}T12:00:00Z`) : ahora;
  const vigencia = vigenciaSat(texto) ?? new Date(base.getTime() + VIGENCIA_DIAS_SAT * 86400000).toISOString().slice(0, 10);
  const motivos = resultado === "NEGATIVA" ? motivosSat(texto) : [];
  if (resultado === "ERROR") motivos.push("No se pudo interpretar el sentido de la opinión en el PDF; ábrelo para leerlo.");
  const folio = folioSat(texto);
  if (folio) motivos.unshift(`Folio SAT: ${folio}`);
  return { tipo: "SAT_OPINION", resultado, motivos, vigencia, fetchedAt: ahora.toISOString() };
}
