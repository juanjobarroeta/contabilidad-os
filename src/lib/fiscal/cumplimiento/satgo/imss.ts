// ─────────────────────────────────────────────────────────────────────────────
// Lectura de la Opinión de Cumplimiento IMSS (OCOFSS) a partir del texto del
// PDF. Visto en vivo (BAOBAB, 13-sep-2026): el documento trae una CADENA
// ORIGINAL estructurada —«|Opinion:SIN OPINIÓN|FechaInicioVigencia:…|
// FechaFinVigencia:13 de septiembre de 2026, 23:59:59|Folio:…|RFC:…|»— y en el
// cuerpo «Por lo anterior, se emite opinión Positiva/Negativa/Sin Opinión»,
// «FECHA: 13 de septiembre de 2026» y «tiene una vigencia hasta el …». Se lee
// primero la cadena (es la firmada), luego el cuerpo, y sólo al final las
// heurísticas. Sin modelos. Si nada casa, ERROR con el motivo — el PDF se
// guarda igual. «Sin Opinión» (registro patronal en baja) → SIN_OBLIGACIONES.
// ─────────────────────────────────────────────────────────────────────────────

import type { OpinionResult, ResultadoOpinion } from "../types";

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

/** Vigencia de la OCOFSS: 30 días naturales desde su emisión (Acuerdo ACDO.SA1.HCT.101214/281.P.DIR, regla séptima). */
export const VIGENCIA_DIAS_IMSS = 30;

const normalizar = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

/** «13 de septiembre de 2026» / «13 de septiembre 2026» / «13/09/2026» → ISO, o null. */
function fechaIsoDe(frag: string): string | null {
  const t = normalizar(frag).toLowerCase();
  const m1 = t.match(/(\d{1,2})\s+de\s+([a-z]+)\s+(?:de\s+)?(\d{4})/);
  if (m1 && MESES[m1[2]]) return `${m1[3]}-${String(MESES[m1[2]]).padStart(2, "0")}-${m1[1].padStart(2, "0")}`;
  const m2 = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2, "0")}-${m2[1].padStart(2, "0")}`;
  return null;
}

/** Campo de la cadena original («|Clave:valor|»), si el PDF la trae. */
function campoCadena(texto: string, clave: string): string | null {
  const m = normalizar(texto).match(new RegExp(`\\|${clave}\\s*:\\s*([^|]*)`, "i"));
  return m ? m[1].trim() : null;
}

/** Fin de vigencia que el propio IMSS imprime (cadena original o «vigencia hasta el …»), o null. */
export function vigenciaImss(texto: string): string | null {
  const c = campoCadena(texto, "FechaFinVigencia");
  if (c) { const f = fechaIsoDe(c); if (f) return f; }
  const m = normalizar(texto).match(/vigencia\s+hasta\s+el\s+([^,.]+)/i);
  return m ? fechaIsoDe(m[1]) : null;
}

/** Fecha de emisión en ISO (YYYY-MM-DD) si aparece como «12 de agosto de 2026» o «12/08/2026». */
export function fechaEmisionImss(texto: string): string | null {
  const c = campoCadena(texto, "Fecha") ?? campoCadena(texto, "FechaInicioVigencia");
  if (c) { const f = fechaIsoDe(c); if (f) return f; }
  const t = normalizar(texto).toLowerCase();
  const m1 = t.match(/(?:fecha\s+de\s+emisi[oó]n|emitida?\s+el|fecha)\s*[:.]?\s*(\d{1,2})\s+de\s+([a-z]+)\s+(?:de\s+)?(\d{4})/);
  if (m1 && MESES[m1[2]]) return `${m1[3]}-${String(MESES[m1[2]]).padStart(2, "0")}-${m1[1].padStart(2, "0")}`;
  const m2 = t.match(/(?:fecha\s+de\s+emisi[oó]n|emitida?\s+el|fecha)\s*[:.]?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2, "0")}-${m2[1].padStart(2, "0")}`;
  const m3 = t.match(/(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/);
  if (m3 && MESES[m3[2]]) return `${m3[3]}-${String(MESES[m3[2]]).padStart(2, "0")}-${m3[1].padStart(2, "0")}`;
  return null;
}

const sentidoDe = (v: string): ResultadoOpinion | null => {
  const u = normalizar(v).toUpperCase();
  if (/^POSITIVA/.test(u)) return "POSITIVA";
  if (/^NEGATIVA/.test(u)) return "NEGATIVA";
  if (/^SIN\s+OPINION/.test(u)) return "SIN_OBLIGACIONES";
  return null;
};

export function sentidoImss(texto: string): ResultadoOpinion {
  // 1. La cadena original (firmada): |Opinion:POSITIVA|
  const c = campoCadena(texto, "Opinion");
  if (c) { const r = sentidoDe(c); if (r) return r; }
  // 2. El cuerpo: «se emite opinión Positiva / Negativa / Sin Opinión»
  const t = normalizar(texto).toUpperCase();
  const m2 = t.match(/SE\s+EMITE\s+(?:LA\s+)?OPINI[OÓ]N\s+(?:DE\s+CUMPLIMIENTO\s+)?(POSITIVA|NEGATIVA|SIN\s+OPINI[OÓ]N)/);
  if (m2) return sentidoDe(m2[1]) ?? "ERROR";
  const m = t.match(/SENTIDO\s+DE\s+LA\s+OPINI[OÓ]N\s*[:.]?\s*(POSITIVA|NEGATIVA)/);
  if (m) return m[1] as ResultadoOpinion;
  if (/OPINI[OÓ]N\s+(DE\s+CUMPLIMIENTO\s+)?POSITIVA|SIN\s+ADEUDOS?|NO\s+TIENE\s+(CREDITOS|ADEUDOS)/.test(t)) return "POSITIVA";
  if (/OPINI[OÓ]N\s+(DE\s+CUMPLIMIENTO\s+)?NEGATIVA|CON\s+ADEUDOS?|TIENE\s+(CREDITOS|ADEUDOS)/.test(t)) return "NEGATIVA";
  if (/NO\s+SE\s+ENCONTR|NO\s+(ESTA|SE\s+ENCUENTRA)\s+REGISTRAD|NO\s+LOCALIZAD/.test(t)) return "NO_LOCALIZADO";
  if (/SIN\s+REGISTRO\s+PATRONAL|NO\s+CUENTA\s+CON\s+REGISTRO\s+PATRONAL/.test(t)) return "SIN_OBLIGACIONES";
  return "ERROR";
}

/** El párrafo en que el IMSS explica su respuesta: entre «se le informa lo siguiente:» y «Por lo anterior». */
export function explicacionImss(texto: string): string | null {
  // Sólo se colapsan espacios: el texto se enseña tal cual, con acentos.
  const m = texto.replace(/\s+/g, " ").match(/se le informa lo siguiente\s*:\s*(.+?)\s*Por lo anterior/i);
  return m ? m[1].trim().slice(0, 400) : null;
}

/** En la negativa: los renglones que nombran créditos, adeudos u omisiones (hasta 8). */
export function motivosImss(texto: string): string[] {
  return texto
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 8 && l.length < 220 && /cr[eé]dito|adeud|omisi|multa|recargo|capitales|periodo\s+\d/i.test(l))
    .slice(0, 8);
}

export function folioImss(texto: string): string | null {
  const c = campoCadena(texto, "Folio");
  if (c && /^[A-Z0-9-]{6,}$/i.test(c)) return c;
  const m = normalizar(texto).match(/folio\s*[:.]?\s*([A-Z0-9-]{6,})/i);
  return m ? m[1] : null;
}

/** Texto del PDF → OpinionResult. `acuseUrl` (data URL) lo pone quien tiene los bytes. */
export function interpretarOpinionImss(texto: string, acuseUrl?: string, ahora = new Date()): OpinionResult {
  const resultado = sentidoImss(texto);
  // Vigencia: la que imprime el IMSS; si no viene, 30 días desde la emisión.
  const emision = fechaEmisionImss(texto);
  const base = emision ? new Date(`${emision}T12:00:00Z`) : ahora;
  const vigencia = vigenciaImss(texto) ?? new Date(base.getTime() + VIGENCIA_DIAS_IMSS * 86400000).toISOString().slice(0, 10);
  const folio = folioImss(texto);
  const motivos = resultado === "NEGATIVA" ? motivosImss(texto) : [];
  const explicacion = explicacionImss(texto);
  if (explicacion && resultado !== "POSITIVA" && !motivos.some((m) => m.includes(explicacion.slice(0, 40)))) motivos.unshift(explicacion);
  if (resultado === "ERROR") motivos.push("No se pudo interpretar el sentido de la opinión en el PDF; ábrelo para leerlo.");
  if (folio) motivos.unshift(`Folio IMSS: ${folio}`);
  return { tipo: "IMSS_OPINION", resultado, motivos, acuseUrl, vigencia, fetchedAt: ahora.toISOString() };
}
