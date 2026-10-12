// ─────────────────────────────────────────────────────────────────────────────
// EL PERIODO QUE EL BANCO IMPRIME. PURO.
//
// Cada banco lo escribe a su manera, y el documento guardaba ese texto tal
// cual en `ImportBatch.periodo`:
//
//   BBVA:      «Periodo DEL 01/08/2026 AL 31/08/2026»
//   Santander: «DEL 01-AGO-2026 AL 31-AGO-2026»
//   Banorte:   «Del 01/Agosto/2026 al 31/Agosto/2026»
//
// El mes del documento se leía sólo de un «AAAA-MM» al inicio de ese texto,
// así que los cinco estados de agosto 2026 de CENTRO —que cuadraban al
// centavo— quedaron «Sin mes: no se detectó el mes que cubre el documento».
// ─────────────────────────────────────────────────────────────────────────────

const MESES: Record<string, number> = {
  ENE: 1, ENERO: 1, FEB: 2, FEBRERO: 2, MAR: 3, MARZO: 3, ABR: 4, ABRIL: 4, MAY: 5, MAYO: 5,
  JUN: 6, JUNIO: 6, JUL: 7, JULIO: 7, AGO: 8, AGOSTO: 8, SEP: 9, SEPT: 9, SEPTIEMBRE: 9, SET: 9, SETIEMBRE: 9,
  OCT: 10, OCTUBRE: 10, NOV: 11, NOVIEMBRE: 11, DIC: 12, DICIEMBRE: 12,
};

/** Número de mes de una abreviatura o nombre en español (ENE, Agosto…), o null. */
export function mesEspanol(s: string): number | null {
  const k = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\./g, "");
  return MESES[k] ?? null;
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const valida = (y: number, m: number, d: number) =>
  y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 && new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;

export interface PeriodoDeclarado { inicio: string; fin: string }

/**
 * La cobertura declarada «DEL x AL y» en cualquiera de los formatos de arriba.
 * Devuelve null si no hay un rango completo y válido: un periodo a medias no
 * se adivina.
 */
export function leerPeriodoDeclarado(texto: string | null | undefined): PeriodoDeclarado | null {
  if (!texto) return null;
  const fecha = String.raw`(\d{1,2})[\/\-\s]([A-Za-zÁÉÍÓÚáéíóú\.]{3,11}|\d{1,2})[\/\-\s](\d{4})`;
  const re = new RegExp(String.raw`\bDEL\s+${fecha}\s+AL\s+${fecha}`, "i");
  const m = re.exec(texto);
  if (!m) return null;
  const parte = (d: string, mm: string, y: string) => {
    const mes = /^\d+$/.test(mm) ? Number(mm) : mesEspanol(mm);
    const dia = Number(d), anio = Number(y);
    return mes != null && valida(anio, mes, dia) ? iso(anio, mes, dia) : null;
  };
  const inicio = parte(m[1], m[2], m[3]), fin = parte(m[4], m[5], m[6]);
  if (!inicio || !fin || inicio > fin) return null;
  return { inicio, fin };
}

/**
 * El mes que cubre un documento: el inicio declarado; si no, el periodo
 * impreso «DEL … AL …»; si no, un «AAAA-MM» al inicio del texto guardado.
 */
export function mesDeCobertura(doc: { periodStart?: string | null; periodo?: string | null }): { year: number; month: number } | null {
  const desde = doc.periodStart ?? leerPeriodoDeclarado(doc.periodo)?.inicio ?? doc.periodo ?? "";
  const m = /^(\d{4})-(\d{2})/.exec(desde);
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]);
  return month >= 1 && month <= 12 ? { year, month } : null;
}

/**
 * Pone en el año del periodo impreso los renglones cuyo día y mes caen dentro
 * de él pero traen otro año. PURA salvo por mutar `fecha`. Devuelve cuántos.
 */
export function corregirAnios(transactions: { fecha: Date }[], periodo: PeriodoDeclarado): number {
  const yIni = Number(periodo.inicio.slice(0, 4)), yFin = Number(periodo.fin.slice(0, 4));
  let n = 0;
  for (const t of transactions) {
    const d = t.fecha.toISOString().slice(0, 10);
    if (d >= periodo.inicio && d <= periodo.fin) continue;
    for (const y of new Set([yIni, yFin])) {
      const candidato = `${y}${d.slice(4)}`;
      if (candidato >= periodo.inicio && candidato <= periodo.fin) { t.fecha = new Date(`${candidato}T12:00:00`); n++; break; }
    }
  }
  return n;
}
