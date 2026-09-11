// ─────────────────────────────────────────────────────────────────────────────
// A QUÉ MES PERTENECE UN LOTE IMPORTADO.
//
// `ImportBatch.periodo` guarda lo que el importador encontró: el CSV pasa
// "2026-08", pero el PDF guarda el texto literal del banco — «Del 01/Agosto/2026
// al 31/Agosto/2026», «DEL 01/08/2026 AL 31/08/2026», «DEL 01-JUL-2026 AL
// 31-JUL-2026»— y quien lo consultaba comparaba contra "2026-08" o hacía
// `split("-")`. Nunca coincidía: el saldo final que el banco sí imprimió no se
// proponía en el papel de conciliación y el encadenado mes a mes no arrancaba.
// Visto en un hospital con tres estados de cuenta de agosto parseados, saldo
// final incluido, y «0 de 4 saldos capturados».
//
// La fuente más fiable no es el texto: son las FECHAS de los movimientos que
// el lote trajo. Un estado de cuenta es mensual; si su primer y su último
// movimiento caen en el mismo mes, ése es su mes. El texto queda como respaldo
// para un lote sin movimientos. Puro y probado.
// ─────────────────────────────────────────────────────────────────────────────

const MESES: Record<string, number> = {
  ene: 1, enero: 1, feb: 2, febrero: 2, mar: 3, marzo: 3, abr: 4, abril: 4,
  may: 5, mayo: 5, jun: 6, junio: 6, jul: 7, julio: 7, ago: 8, agosto: 8,
  sep: 9, sept: 9, septiembre: 9, set: 9, setiembre: 9, oct: 10, octubre: 10,
  nov: 11, noviembre: 11, dic: 12, diciembre: 12,
};

/** "YYYY-MM" o null. */
export function claveMes(year: number, month: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 2000 || year > 2100) return null;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Lee un mes de un texto de periodo. Devuelve "YYYY-MM" cuando TODAS las
 * menciones de mes/año del texto son del mismo mes; null si no hay ninguna o
 * si el texto abarca dos meses (un rango «del 15/jul al 15/ago» no tiene un
 * solo mes, y adivinar sería peor que no proponer).
 */
export function periodoDeTexto(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const t = texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // "2026-08" tal cual.
  const iso = /^\s*(\d{4})-(\d{2})\s*$/.exec(t);
  if (iso) return claveMes(Number(iso[1]), Number(iso[2]));

  const vistos = new Set<string>();
  // dd/mm/yyyy · dd-mm-yyyy · mm/yyyy
  for (const m of t.matchAll(/(?:\b\d{1,2}[\/-])?\b(\d{1,2})[\/-](\d{4})\b/g)) {
    const k = claveMes(Number(m[2]), Number(m[1]));
    if (k) vistos.add(k);
  }
  // dd/Agosto/2026 · 01-JUL-2026 · agosto 2026 · agosto de 2026
  for (const m of t.matchAll(/\b([a-z]{3,10})\.?(?:[\/\-\s]+de)?[\/\-\s]+(\d{4})\b/g)) {
    const mes = MESES[m[1]];
    if (!mes) continue;
    const k = claveMes(Number(m[2]), mes);
    if (k) vistos.add(k);
  }
  return vistos.size === 1 ? [...vistos][0] : null;
}

/**
 * El mes de un lote: por las fechas de sus movimientos si las hay y caen en un
 * solo mes (UTC, el mismo corte que el resto de Bancos); si no, por el texto.
 */
export function mesDeLote(l: {
  periodo: string | null;
  minFecha?: Date | null;
  maxFecha?: Date | null;
}): string | null {
  if (l.minFecha && l.maxFecha) {
    const a = claveMes(l.minFecha.getUTCFullYear(), l.minFecha.getUTCMonth() + 1);
    const b = claveMes(l.maxFecha.getUTCFullYear(), l.maxFecha.getUTCMonth() + 1);
    if (a && a === b) return a;
  }
  return periodoDeTexto(l.periodo);
}
