// ─────────────────────────────────────────────────────────────────────────────
// Anexo 8 de la RMF — tarifas del ISR (pagos provisionales, retenciones por
// periodo, Art. 106 acumuladas, bimestrales y anual Art. 152). PDF del DOF en
// el minisitio del SAT. Parser PURO probado con el fixture real de 2026.
//
// Nota: el subsidio para el empleo NO viene en el Anexo 8 (es un decreto
// aparte); sigue en tarifas.ts por PR revisado.
// ─────────────────────────────────────────────────────────────────────────────

import { limpiarLineasDof, mesNumero, montoNumero } from "./texto";

export type PeriodoTarifa =
  | "inmuebles" // pagos provisionales por enajenación de inmuebles (Art. 126)
  | "diaria"
  | "semanal"
  | "decenal"
  | "quincenal"
  | "mensual" // Art. 96 (sueldos) — también Art. 116
  | "acumulada" // Art. 106, tarifa del mes N (acumulada enero..N)
  | "bimestral" // RIF definitivos
  | "bimestral_acumulada" // RIF con coeficiente
  | "anual" // Art. 152 (y 97)
  | "otra";

export interface FilaTarifaAnexo8 {
  limiteInferior: number;
  /** null = «En adelante». */
  limiteSuperior: number | null;
  cuotaFija: number;
  /** Decimal (0.0192). */
  tasaExcedente: number;
}

export interface TarifaAnexo8 {
  seccion: string;
  numeral: string | null;
  titulo: string;
  periodo: PeriodoTarifa;
  /** Mes (1–12) para las acumuladas del Art. 106 y el mes final de los bimestres. */
  mes: number | null;
  /** Ejercicio al que corresponde la tarifa (la anual trae 2025 y 2026 en el Anexo de 2026). */
  ejercicioTarifa: number | null;
  filas: FilaTarifaAnexo8[];
}

export interface Anexo8Parseado {
  ejercicio: number;
  dof: string | null;
  tarifas: TarifaAnexo8[];
}

const RE_SECCION = /^([A-D])\.\s+(Tarifa.*)$/;
const RE_NUMERAL = /^([IVX]+)\.\s+(Tarifa.*)$/;
const RE_TITULO = /^Tarifa\s+(?:del|aplicable|para|opcional)\b.*$/;
const RE_FILA = /^([\d,]+\.\d{2})\s+([\d,]+\.\d{2}|En adelante)\s+([\d,]+(?:\.\d{1,2})?)\s+(\d{1,2}(?:\.\d{1,2})?)$/;
const RE_LIMITE = /^L[íi]mite inferior/i;

/** Clasifica una tarifa por su título. Puro. */
export function clasificarTitulo(titulo: string): { periodo: PeriodoTarifa; mes: number | null; ejercicioTarifa: number | null } {
  const t = titulo.toLowerCase().replace(/\s+/g, " ");
  const anio = /\b(20\d{2})\b/.exec(t);
  const ejercicioTarifa = anio ? Number(anio[1]) : null;
  if (t.includes("enajenaci") && t.includes("inmuebles")) return { periodo: "inmuebles", mes: null, ejercicioTarifa };
  if (t.includes("calculada en d")) return { periodo: "diaria", mes: null, ejercicioTarifa };
  if (t.includes("periodo de 7 d")) return { periodo: "semanal", mes: null, ejercicioTarifa };
  if (t.includes("periodo de 10 d")) return { periodo: "decenal", mes: null, ejercicioTarifa };
  if (t.includes("periodo de 15 d")) return { periodo: "quincenal", mes: null, ejercicioTarifa };
  const mesArt106 = /tarifa del mes de ([a-záéíóú]+) de (\d{4})/.exec(t);
  if (mesArt106 && t.includes("106")) return { periodo: "acumulada", mes: mesNumero(mesArt106[1]), ejercicioTarifa: Number(mesArt106[2]) };
  if (t.includes("bimestrales definitivos")) return { periodo: "bimestral", mes: null, ejercicioTarifa };
  const bim = /bimestre [a-záéíóú]+-([a-záéíóú]+) de (\d{4})/.exec(t);
  if (bim) return { periodo: "bimestral_acumulada", mes: mesNumero(bim[1]), ejercicioTarifa: Number(bim[2]) };
  if (t.includes("pagos provisionales mensuales") && t.includes("96")) return { periodo: "mensual", mes: null, ejercicioTarifa };
  const ej = /ejercicio de (\d{4})/.exec(t);
  if (ej && (t.includes("152") || t.includes("97"))) return { periodo: "anual", mes: null, ejercicioTarifa: Number(ej[1]) };
  return { periodo: "otra", mes: null, ejercicioTarifa };
}

/** Parsea el texto completo del Anexo 8. Puro. */
export function parseAnexo8(texto: string): Anexo8Parseado {
  const ej = /RESOLUCI[ÓO]N MISCEL[ÁA]NEA FISCAL PARA\s+(\d{4})/i.exec(texto);
  const dofM = /DIARIO OFICIAL\s+\w+\s+(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i.exec(texto);
  const lineas = limpiarLineasDof(texto);
  const tarifas: TarifaAnexo8[] = [];
  let seccion = "";
  let actual: TarifaAnexo8 | null = null;
  let enTitulo = false;

  const nueva = (numeral: string | null, titulo: string): TarifaAnexo8 => {
    const t: TarifaAnexo8 = { seccion, numeral, titulo, periodo: "otra", mes: null, ejercicioTarifa: null, filas: [] };
    tarifas.push(t);
    enTitulo = true;
    return t;
  };

  for (const line of lineas) {
    const s = RE_SECCION.exec(line);
    if (s) {
      seccion = s[1];
      actual = null;
      enTitulo = false;
      continue;
    }
    const n = RE_NUMERAL.exec(line);
    if (n) {
      actual = nueva(n[1], n[2]);
      continue;
    }
    if (RE_TITULO.test(line) && (!actual || actual.filas.length > 0 || !enTitulo)) {
      actual = nueva(null, line);
      continue;
    }
    if (!actual) continue;
    if (RE_LIMITE.test(line)) {
      enTitulo = false;
      continue;
    }
    const f = RE_FILA.exec(line);
    if (f) {
      enTitulo = false;
      actual.filas.push({
        limiteInferior: montoNumero(f[1]),
        limiteSuperior: /en adelante/i.test(f[2]) ? null : montoNumero(f[2]),
        cuotaFija: montoNumero(f[3]),
        tasaExcedente: Math.round(Number(f[4]) * 100) / 10000,
      });
      continue;
    }
    if (enTitulo && !/^\$|^Por ciento|^aplicarse|^sobre el|^excedente|^inferior$|^l[íi]mite/i.test(line)) {
      actual.titulo = `${actual.titulo} ${line}`;
    }
  }

  // El índice del principio repite los títulos sin filas: fuera.
  const conFilas = tarifas.filter((t) => t.filas.length > 0);
  for (const t of conFilas) Object.assign(t, clasificarTitulo(t.titulo));
  return { ejercicio: ej ? Number(ej[1]) : NaN, dof: dofM ? `${dofM[3]}-${String(mesNumero(dofM[2]) ?? 0).padStart(2, "0")}-${dofM[1].padStart(2, "0")}` : null, tarifas: conFilas };
}

/** Comparación fila por fila (límite inferior, cuota, tasa) con tolerancia de centavos. Puro. */
export function tarifasCoinciden(
  a: { limiteInferior: number; cuotaFija: number; tasaExcedente: number }[],
  b: { limiteInferior: number; cuotaFija: number; tasaExcedente: number }[],
  tolerancia = 0.011
): { ok: boolean; diferencias: string[] } {
  const diferencias: string[] = [];
  if (a.length !== b.length) diferencias.push(`filas: ${a.length} vs ${b.length}`);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (Math.abs(a[i].limiteInferior - b[i].limiteInferior) > tolerancia) diferencias.push(`fila ${i + 1} límite inferior ${a[i].limiteInferior} vs ${b[i].limiteInferior}`);
    if (Math.abs(a[i].cuotaFija - b[i].cuotaFija) > tolerancia) diferencias.push(`fila ${i + 1} cuota fija ${a[i].cuotaFija} vs ${b[i].cuotaFija}`);
    if (Math.abs(a[i].tasaExcedente - b[i].tasaExcedente) > 1e-6) diferencias.push(`fila ${i + 1} tasa ${a[i].tasaExcedente} vs ${b[i].tasaExcedente}`);
  }
  return { ok: diferencias.length === 0, diferencias };
}
