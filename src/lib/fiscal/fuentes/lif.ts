// ─────────────────────────────────────────────────────────────────────────────
// Ley de Ingresos de la Federación — tasa de recargos (prórroga y pago a
// plazos). Texto vigente en la Cámara de Diputados, mismo origen que LISR/CFF.
//
// Se localiza el artículo por su CONTENIDO («En los casos de prórroga para el
// pago de créditos fiscales se causarán recargos»), no por número: en la LIF
// 2026 es el Art. 11; en ejercicios anteriores fue el Art. 8.
//
// La tasa por MORA no la fija la LIF: el Art. 21 CFF la define como la de
// prórroga incrementada en 50 % (recargosMora en recargos.ts).
// ─────────────────────────────────────────────────────────────────────────────

export interface RecargosLif {
  ejercicio: number;
  /** Artículo de la LIF donde está («11»). */
  articulo: string;
  /** Tasa mensual de prórroga (decimal: 0.0138). */
  prorroga: number;
  /** Pago a plazos (Art. 66 CFF): tasa mensual por tramo de parcialidades. */
  parcialidades: { hastaMeses: number | null; tasa: number }[];
  /** Fragmento del artículo, para citarlo. */
  texto: string;
}

export function urlLif(ejercicio: number): string {
  return `https://www.diputados.gob.mx/LeyesBiblio/pdf/LIF_${ejercicio}.pdf`;
}

const pct = (s: string) => Math.round(Number(s) * 100) / 10000;

/** Mora derivada de la prórroga (Art. 21 CFF, segundo párrafo: +50 %). Puro. */
export function tasaMoraDesdeProrroga(prorroga: number): number {
  return Math.round(prorroga * 1.5 * 10000) / 10000;
}

/** Parsea el artículo de recargos de la LIF. Devuelve null si no lo encuentra. Puro. */
export function parseRecargosLif(texto: string): RecargosLif | null {
  const t = texto.replace(/\r/g, "");
  const ejM = /EJERCICIO FISCAL DE\s+(\d{4})/i.exec(t);
  const inicio = /Art[íi]culo\s+(\d+)o?\.\s+En los casos de pr[óo]rroga para el pago de cr[ée]ditos fiscales se causar[áa]n recargos/i.exec(t);
  if (!inicio) return null;
  const fin = t.indexOf("Artículo", inicio.index + 20);
  const cuerpo = t.slice(inicio.index, fin > 0 ? fin : inicio.index + 2500).replace(/\s+/g, " ");
  const pro = /Al\s+([\d.]+)\s+por\s+ciento\s+mensual/i.exec(cuerpo);
  if (!pro) return null;
  const parcialidades: { hastaMeses: number | null; tasa: number }[] = [];
  const p12 = /hasta\s+12\s+meses,?\s+la\s+tasa\s+de\s+recargos\s+ser[áa]\s+de[l]?\s+([\d.]+)\s+por/i.exec(cuerpo);
  const p24 = /m[áa]s\s+de\s+12\s+meses\s+y\s+hasta\s+de\s+24\s+meses,?\s+la\s+tasa\s+de\s+recargos\s+ser[áa]\s+de[l]?\s+([\d.]+)\s+por/i.exec(cuerpo);
  const p36 = /superiores\s+a\s+24\s+meses[^.]*?la\s+tasa\s+de\s+recargos\s+ser[áa]\s+de[l]?\s+([\d.]+)\s+por/i.exec(cuerpo);
  if (p12) parcialidades.push({ hastaMeses: 12, tasa: pct(p12[1]) });
  if (p24) parcialidades.push({ hastaMeses: 24, tasa: pct(p24[1]) });
  if (p36) parcialidades.push({ hastaMeses: null, tasa: pct(p36[1]) });
  return {
    ejercicio: ejM ? Number(ejM[1]) : NaN,
    articulo: inicio[1],
    prorroga: pct(pro[1]),
    parcialidades,
    texto: cuerpo.slice(0, 900),
  };
}
