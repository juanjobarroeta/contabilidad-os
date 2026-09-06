// ─────────────────────────────────────────────────────────────────────────────
// Leer la balanza del contador para la apertura (P3c).
//
// El hospital que migra a media vida trae sus saldos en la balanza de
// comprobación que le exporta su sistema anterior: xlsx o csv con columnas que
// cada sistema nombra a su manera. Aquí se detectan (cuenta/código, nombre,
// saldo deudor/acreedor o un saldo final con signo), se leen las líneas, se
// separan las cuentas AGRUPADORAS (las que suman a sus hijas: contarlas
// duplicaría el asiento) y se propone la cuenta del catálogo de la empresa
// para cada línea: por código exacto, por el agrupador del SAT que lleva el
// código (101.01…) o por parecido del nombre. Lo que no se pueda proponer sale
// en `sinMapear`; la apertura no se asienta si la balanza no cuadra.
//
// Todo es puro salvo `filasDeArchivo` (xlsx), para poder probarlo con hojas
// armadas en el test.
// ─────────────────────────────────────────────────────────────────────────────

import * as XLSX from "xlsx";
import { toleranciaPorRedondeo } from "../contabilidad/apertura";
import { HospitalError } from "./errores";
import { r2 } from "./util";

export interface CuentaCatalogo {
  id?: string;
  codigo: string;
  nombre: string;
  tipo: string;
  naturaleza: "D" | "A";
  nivel?: number;
}

export interface ColumnasBalanza {
  /** Índice de la fila de encabezado; null si se dedujo por posición. */
  encabezado: number | null;
  codigo: number;
  nombre: number | null;
  deudor: number | null;
  acreedor: number | null;
  /** Saldo final con signo (+ deudor, − acreedor) cuando no vienen dos columnas. */
  saldo: number | null;
}

export interface LineaBalanza {
  fila: number;
  codigo: string;
  nombre: string;
  saldoDeudor: number;
  saldoAcreedor: number;
  /** Cuenta de mayor: otra línea cuelga de ella (su saldo ya está en las hijas). */
  agrupadora: boolean;
}

export type Confianza = "EXACTA" | "PREFIJO" | "NOMBRE";

export interface LineaSugerida extends LineaBalanza {
  /** Saldo en signo natural de la cuenta sugerida (deudora +cargo, acreedora +abono): lo que espera postApertura. */
  saldo: number;
  cuentaSugerida: CuentaCatalogo | null;
  confianza: Confianza | null;
}

export interface ResultadoBalanza {
  columnas: ColumnasBalanza;
  lineas: LineaSugerida[];
  sinMapear: LineaSugerida[];
  totales: { cuentas: number; deudor: number; acreedor: number; diferencia: number; tolerancia: number; cuadra: boolean };
  advertencia: string | null;
}

const normalizar = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function textoCelda(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (v instanceof Date) return "";
  return String(v).trim();
}

/** «$1,234.50», «(500.00)», «-500», « 1 234,50 » → número; vacío o texto → null. */
export function numero(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s || s === "-" || s === "—") return null;
  const negativo = /^\(.*\)$/.test(s) || s.startsWith("-");
  s = s.replace(/[()\s$]/g, "").replace(/^-/, "").replace(/^MXN|MXN$/i, "");
  // «1.234,56» (coma decimal) → «1234.56»; «1,234.56» → «1234.56».
  if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (negativo ? -n : n) : null;
}

const RE_NOMBRE = /nombre|descripcion|concepto|denominacion/;
const RE_CODIGO = /codigo|clave|\bcuenta\b|\bcta\b|numero/;
const RE_DEUDOR = /deudor|saldo.*\bdebe\b|\bdebe\b.*saldo|\bcargo\b.*saldo|saldo.*\bcargo/;
const RE_ACREEDOR = /acreedor|saldo.*\bhaber\b|\bhaber\b.*saldo|\babono\b.*saldo|saldo.*\babono/;
const RE_SALDO = /saldo/;
const RE_FINAL = /final|actual|\bal\b|cierre/;
const RE_CODIGO_VALIDO = /^(?=.*\d)[0-9A-Za-z][0-9A-Za-z.\-\/ ]*$/;

const elegir = (indices: number[], preferido: (c: string) => boolean, celdas: string[]): number | null => {
  if (indices.length === 0) return null;
  const pref = indices.filter((i) => preferido(celdas[i]));
  return (pref.length ? pref : indices)[pref.length ? 0 : indices.length - 1];
};

/** Detecta la fila de encabezado y las columnas; por posición si no hay encabezado. */
export function detectarColumnas(filas: unknown[][]): ColumnasBalanza | null {
  const tope = Math.min(filas.length, 40);
  for (let r = 0; r < tope; r++) {
    const celdas = (filas[r] ?? []).map((c) => normalizar(textoCelda(c)));
    if (celdas.filter(Boolean).length < 2) continue;
    const indices = (re: RegExp) => celdas.map((c, i) => (c && re.test(c) ? i : -1)).filter((i) => i >= 0);
    const nombre = indices(RE_NOMBRE)[0] ?? null;
    const codigos = indices(RE_CODIGO).filter((i) => i !== nombre && !RE_DEUDOR.test(celdas[i]) && !RE_ACREEDOR.test(celdas[i]) && !RE_SALDO.test(celdas[i]));
    const codigo = codigos.find((i) => /codigo|clave/.test(celdas[i])) ?? codigos[0];
    if (codigo == null) continue;
    const deudor = elegir(indices(RE_DEUDOR), (c) => RE_FINAL.test(c), celdas);
    const acreedor = elegir(indices(RE_ACREEDOR), (c) => RE_FINAL.test(c), celdas);
    const saldo =
      deudor == null && acreedor == null
        ? elegir(
            indices(RE_SALDO).filter((i) => i !== codigo && i !== nombre),
            (c) => RE_FINAL.test(c),
            celdas
          )
        : null;
    if ((deudor != null && acreedor != null) || saldo != null) {
      return { encabezado: r, codigo, nombre, deudor, acreedor, saldo };
    }
  }
  // Sin encabezado reconocible: primera fila con código en la columna 0 y
  // números a la derecha — dos columnas numéricas son deudor/acreedor, una es
  // el saldo con signo.
  for (let r = 0; r < tope; r++) {
    const fila = filas[r] ?? [];
    const codigo = textoCelda(fila[0]);
    if (!RE_CODIGO_VALIDO.test(codigo)) continue;
    const numericas = fila.map((c, i) => (i > 0 && numero(c) != null && !(typeof c === "string" && /[A-Za-z]/.test(c)) ? i : -1)).filter((i) => i >= 0);
    if (numericas.length === 0) continue;
    const nombre = fila.length > 1 && numero(fila[1]) == null && textoCelda(fila[1]) ? 1 : null;
    const utiles = numericas.filter((i) => i !== nombre);
    if (utiles.length >= 2) {
      return { encabezado: null, codigo: 0, nombre, deudor: utiles[utiles.length - 2], acreedor: utiles[utiles.length - 1], saldo: null };
    }
    return { encabezado: null, codigo: 0, nombre, deudor: null, acreedor: null, saldo: utiles[0] };
  }
  return null;
}

const SEPARADOR = /[.\-\/ ]/;

export function marcarAgrupadoras<T extends { codigo: string }>(lineas: T[]): Array<T & { agrupadora: boolean }> {
  const codigos = lineas.map((l) => l.codigo);
  return lineas.map((l) => ({
    ...l,
    agrupadora: codigos.some((o) => o.length > l.codigo.length && o.startsWith(l.codigo) && SEPARADOR.test(o.charAt(l.codigo.length))),
  }));
}

/** Filas crudas de la hoja → líneas con código, nombre y saldos. Lanza 400 si no se reconoce la forma. */
export function interpretarBalanza(filas: unknown[][]): { columnas: ColumnasBalanza; lineas: LineaBalanza[] } {
  const columnas = detectarColumnas(filas);
  if (!columnas) {
    throw new HospitalError(400, "No se reconocen las columnas de la balanza: se esperan cuenta/código, nombre y saldo deudor/acreedor (o saldo final)");
  }
  const crudas: Array<Omit<LineaBalanza, "agrupadora">> = [];
  for (let r = (columnas.encabezado ?? -1) + 1; r < filas.length; r++) {
    const fila = filas[r] ?? [];
    const codigo = textoCelda(fila[columnas.codigo]);
    if (!codigo || !RE_CODIGO_VALIDO.test(codigo)) continue;
    if (/^(total|suma|sumas)\b/i.test(codigo)) continue;
    const nombre = columnas.nombre == null ? "" : textoCelda(fila[columnas.nombre]);
    if (/^(total|suma|sumas)\b/i.test(normalizar(nombre))) continue;
    let saldoDeudor = 0;
    let saldoAcreedor = 0;
    if (columnas.saldo != null) {
      const s = numero(fila[columnas.saldo]) ?? 0;
      saldoDeudor = s > 0 ? s : 0;
      saldoAcreedor = s < 0 ? -s : 0;
    } else {
      saldoDeudor = numero(fila[columnas.deudor!]) ?? 0;
      saldoAcreedor = numero(fila[columnas.acreedor!]) ?? 0;
      // Un saldo negativo en una columna es el otro lado.
      if (saldoDeudor < 0) {
        saldoAcreedor += -saldoDeudor;
        saldoDeudor = 0;
      }
      if (saldoAcreedor < 0) {
        saldoDeudor += -saldoAcreedor;
        saldoAcreedor = 0;
      }
    }
    crudas.push({ fila: r + 1, codigo, nombre, saldoDeudor: r2(saldoDeudor), saldoAcreedor: r2(saldoAcreedor) });
  }
  if (crudas.length === 0) throw new HospitalError(400, "La balanza no trae líneas con cuenta y saldo");
  return { columnas, lineas: marcarAgrupadoras(crudas) };
}

// ─── Sugerencia de cuenta ────────────────────────────────────────────────────

const STOP = new Set(["de", "del", "la", "el", "los", "las", "y", "o", "a", "en", "por", "para", "con", "sin", "al", "un", "una"]);

export function tokens(s: string): Set<string> {
  return new Set(
    normalizar(s)
      .replace(/[^a-z0-9 ]/g, " ")
      .split(" ")
      .filter((t) => t.length >= 3 && !STOP.has(t))
  );
}

/** Jaccard sobre palabras significativas: 1 = mismo nombre, 0 = nada en común. */
export function similitudNombre(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let comunes = 0;
  for (const t of ta) if (tb.has(t)) comunes++;
  return comunes / (ta.size + tb.size - comunes);
}

const soloAlfanumerico = (s: string) => s.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
const RE_AGRUPADOR = /^(\d{3})(?:[.\-\/](\d{1,2}))?(?!\d)/;

export const UMBRAL_NOMBRE = 0.5;

export function sugerirCuenta(linea: { codigo: string; nombre: string }, catalogo: CuentaCatalogo[]): { cuenta: CuentaCatalogo; confianza: Confianza } | null {
  const exacta = catalogo.find((c) => c.codigo === linea.codigo) ?? catalogo.find((c) => soloAlfanumerico(c.codigo) === soloAlfanumerico(linea.codigo));
  if (exacta) return { cuenta: exacta, confianza: "EXACTA" };

  const m = RE_AGRUPADOR.exec(linea.codigo);
  if (m) {
    const candidatos = m[2] ? [`${m[1]}.${m[2].padStart(2, "0")}`, m[1]] : [m[1]];
    for (const codigo of candidatos) {
      const c = catalogo.find((x) => x.codigo === codigo);
      if (c) return { cuenta: c, confianza: "PREFIJO" };
    }
  }

  if (linea.nombre.trim()) {
    let mejor: { cuenta: CuentaCatalogo; puntaje: number } | null = null;
    for (const c of catalogo) {
      const puntaje = similitudNombre(linea.nombre, c.nombre);
      if (puntaje < UMBRAL_NOMBRE) continue;
      if (!mejor || puntaje > mejor.puntaje || (puntaje === mejor.puntaje && c.nombre.length < mejor.cuenta.nombre.length)) mejor = { cuenta: c, puntaje };
    }
    if (mejor) return { cuenta: mejor.cuenta, confianza: "NOMBRE" };
  }
  return null;
}

export function analizarBalanza(filas: unknown[][], catalogo: CuentaCatalogo[]): ResultadoBalanza {
  const { columnas, lineas } = interpretarBalanza(filas);
  const sugeridas: LineaSugerida[] = lineas.map((l) => {
    const s = l.agrupadora ? null : sugerirCuenta(l, catalogo);
    const naturaleza = s?.cuenta.naturaleza ?? "D";
    return {
      ...l,
      saldo: r2(naturaleza === "D" ? l.saldoDeudor - l.saldoAcreedor : l.saldoAcreedor - l.saldoDeudor),
      cuentaSugerida: s?.cuenta ?? null,
      confianza: s?.confianza ?? null,
    };
  });
  const detalle = sugeridas.filter((l) => !l.agrupadora);
  const deudor = r2(detalle.reduce((s, l) => s + l.saldoDeudor, 0));
  const acreedor = r2(detalle.reduce((s, l) => s + l.saldoAcreedor, 0));
  const diferencia = r2(deudor - acreedor);
  const tolerancia = toleranciaPorRedondeo(detalle.length);
  const cuadra = Math.abs(diferencia) <= tolerancia;
  const sinMapear = detalle.filter((l) => !l.cuentaSugerida && (l.saldoDeudor !== 0 || l.saldoAcreedor !== 0));
  const advertencia = !cuadra
    ? `La balanza no cuadra: deudor ${deudor.toFixed(2)} contra acreedor ${acreedor.toFixed(2)} (diferencia ${diferencia.toFixed(2)}). Revisa si faltan cuentas de capital o resultados.`
    : sinMapear.length > 0
      ? `${sinMapear.length} cuenta${sinMapear.length === 1 ? "" : "s"} con saldo sin cuenta sugerida: asígnalas antes de asentar la apertura.`
      : null;
  return { columnas, lineas: sugeridas, sinMapear, totales: { cuentas: detalle.length, deudor, acreedor, diferencia, tolerancia, cuadra }, advertencia };
}

/** La primera hoja con filas del xlsx/csv, como matriz. */
export function filasDeArchivo(buffer: Buffer, nombre: string): unknown[][] {
  const esCsv = /\.(csv|txt)$/i.test(nombre);
  let wb: XLSX.WorkBook;
  try {
    wb = esCsv
      ? XLSX.read(buffer.toString("utf8").replace(/^\uFEFF/, ""), { type: "string", raw: true })
      : XLSX.read(buffer, { type: "buffer" });
  } catch {
    throw new HospitalError(400, "No se pudo leer el archivo: manda un xlsx, xls o csv");
  }
  for (const hoja of wb.SheetNames) {
    const ws = wb.Sheets[hoja];
    if (!ws) continue;
    const filas = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: true, blankrows: false });
    if (filas.length > 0) return filas;
  }
  throw new HospitalError(400, "El archivo no trae hojas con datos");
}

export function leerBalanza(buffer: Buffer, nombre: string, catalogo: CuentaCatalogo[]): ResultadoBalanza {
  return analizarBalanza(filasDeArchivo(buffer, nombre), catalogo);
}
