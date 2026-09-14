// ─────────────────────────────────────────────────────────────────────────────
// Lectura de la Opinión de Cumplimiento IMSS (OCOFSS) a partir del texto del
// PDF. Es un documento estable: «Sentido de la opinión: POSITIVA/NEGATIVA»,
// folio, fecha de emisión, y en la negativa los créditos/omisiones. Nada de
// modelos: son tres expresiones regulares y una fecha. Si no se reconoce el
// sentido, se devuelve ERROR con el motivo — el PDF se guarda igual.
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

/** Fecha de emisión en ISO (YYYY-MM-DD) si aparece como «12 de agosto de 2026» o «12/08/2026». */
export function fechaEmisionImss(texto: string): string | null {
  const t = normalizar(texto).toLowerCase();
  const m1 = t.match(/(?:fecha\s+de\s+emisi[oó]n|emitida?\s+el|fecha)\s*[:.]?\s*(\d{1,2})\s+de\s+([a-z]+)\s+(?:de\s+)?(\d{4})/);
  if (m1 && MESES[m1[2]]) return `${m1[3]}-${String(MESES[m1[2]]).padStart(2, "0")}-${m1[1].padStart(2, "0")}`;
  const m2 = t.match(/(?:fecha\s+de\s+emisi[oó]n|emitida?\s+el|fecha)\s*[:.]?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2, "0")}-${m2[1].padStart(2, "0")}`;
  const m3 = t.match(/(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/);
  if (m3 && MESES[m3[2]]) return `${m3[3]}-${String(MESES[m3[2]]).padStart(2, "0")}-${m3[1].padStart(2, "0")}`;
  return null;
}

export function sentidoImss(texto: string): ResultadoOpinion {
  const t = normalizar(texto).toUpperCase();
  const m = t.match(/SENTIDO\s+DE\s+LA\s+OPINI[OÓ]N\s*[:.]?\s*(POSITIVA|NEGATIVA)/);
  if (m) return m[1] as ResultadoOpinion;
  if (/OPINI[OÓ]N\s+(DE\s+CUMPLIMIENTO\s+)?POSITIVA|SIN\s+ADEUDOS?|NO\s+TIENE\s+(CREDITOS|ADEUDOS)/.test(t)) return "POSITIVA";
  if (/OPINI[OÓ]N\s+(DE\s+CUMPLIMIENTO\s+)?NEGATIVA|CON\s+ADEUDOS?|TIENE\s+(CREDITOS|ADEUDOS)/.test(t)) return "NEGATIVA";
  if (/NO\s+SE\s+ENCONTR|NO\s+(ESTA|SE\s+ENCUENTRA)\s+REGISTRAD|NO\s+LOCALIZAD/.test(t)) return "NO_LOCALIZADO";
  if (/SIN\s+REGISTRO\s+PATRONAL|NO\s+CUENTA\s+CON\s+REGISTRO\s+PATRONAL/.test(t)) return "SIN_OBLIGACIONES";
  return "ERROR";
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
  const m = normalizar(texto).match(/folio\s*[:.]?\s*([A-Z0-9-]{6,})/i);
  return m ? m[1] : null;
}

/** Texto del PDF → OpinionResult. `acuseUrl` (data URL) lo pone quien tiene los bytes. */
export function interpretarOpinionImss(texto: string, acuseUrl?: string, ahora = new Date()): OpinionResult {
  const resultado = sentidoImss(texto);
  const emision = fechaEmisionImss(texto);
  const base = emision ? new Date(`${emision}T12:00:00Z`) : ahora;
  const vigencia = new Date(base.getTime() + VIGENCIA_DIAS_IMSS * 86400000).toISOString().slice(0, 10);
  const folio = folioImss(texto);
  const motivos = resultado === "NEGATIVA" ? motivosImss(texto) : [];
  if (resultado === "ERROR") motivos.push("No se pudo interpretar el sentido de la opinión en el PDF; ábrelo para leerlo.");
  if (folio) motivos.unshift(`Folio IMSS: ${folio}`);
  return { tipo: "IMSS_OPINION", resultado, motivos, acuseUrl, vigencia, fetchedAt: ahora.toISOString() };
}
