// ─────────────────────────────────────────────────────────────────────────────
// SAEH — texto y formatos como los pide la GIIS-B002-05-09.
//
// Nombres: A-Z y Ñ en mayúsculas, sin acentos, con «- . / '» y diéresis sobre
// vocales; descripciones (afección, comorbilidad, procedimiento, causa
// externa): sólo 0-9, A-Z y Ñ; «especifique procedencia»: sólo letras;
// «otra localidad»: dígitos, letras y «. ; - _ / ( )». Fechas dd/mm/aaaa en
// hora local del hospital; peso ###.###; cédula 6-14 caracteres con ceros a
// la izquierda. El exportador normaliza siempre; el validador avisa cuando la
// normalización tuvo que quitar algo.
// ─────────────────────────────────────────────────────────────────────────────

import { partesLocales } from "../tz";

/**
 * Quita acentos conservando la Ñ y, si se pide, la diéresis (Ü, Ö…). Trabaja
 * en NFD: la eñe se recompone antes de barrer las marcas combinantes.
 */
export function quitarAcentos(s: string, conservarDieresis = false): string {
  // En NFD la eñe es N + U+0303: se recompone antes de barrer las marcas.
  const nfd = s.normalize("NFD").replace(/N\u0303/g, "\u00d1").replace(/n\u0303/g, "\u00f1");
  const sinMarcas = conservarDieresis ? nfd.replace(/[\u0300-\u0307\u0309-\u036f]/g, "") : nfd.replace(/[\u0300-\u036f]/g, "");
  return sinMarcas.normalize("NFC");
}

const colapsarEspacios = (s: string) => s.replace(/\s+/g, " ").trim();

/** Nombres y apellidos (variables 4-6 y 94-96): A-Z Ñ, diéresis, «- . / '»; un solo espacio; sin especiales consecutivos. */
export function normalizarNombre(s: string | null | undefined): string {
  if (!s) return "";
  const base = quitarAcentos(s, true).toUpperCase().replace(/[’`´]/g, "'");
  const filtrado = base.replace(/[^A-ZÑÄËÏÖÜ\-./' ]/g, " ");
  // Dos especiales seguidos («--», «.-») no se admiten: se deja el primero.
  return colapsarEspacios(filtrado).replace(/([\-./'])[\-./']+/g, "$1").replace(/\s+([\-./'])\s+/g, " $1 ");
}

/** Descripciones libres (48, 51, 55, 60): 0-9 A-Z Ñ y espacio, máximo 250, debe iniciar con letra. */
export function normalizarDescripcion(s: string | null | undefined, max = 250): string {
  if (!s) return "";
  const base = quitarAcentos(s).toUpperCase().replace(/[^0-9A-ZÑ ]/g, " ");
  return colapsarEspacios(base).replace(/^[^A-ZÑ]+/, "").slice(0, max).trim();
}

/** especifiqueProcedencia (43): sólo A-Z Ñ y espacio, máximo 50. */
export function normalizarEspecifique(s: string | null | undefined): string {
  if (!s) return "";
  return colapsarEspacios(quitarAcentos(s).toUpperCase().replace(/[^A-ZÑ ]/g, " ")).slice(0, 50).trim();
}

/** otroMetodo (81): 0-9 A-Z Ñ y espacio, máximo 250. */
export function normalizarOtroMetodo(s: string | null | undefined): string {
  if (!s) return "";
  return colapsarEspacios(quitarAcentos(s).toUpperCase().replace(/[^0-9A-ZÑ ]/g, " ")).slice(0, 250).trim();
}

/** otraLocalidad (29): 0-9 A-Z Ñ, espacio y «. ; - _ / ( )», máximo 50. */
export function normalizarOtraLocalidad(s: string | null | undefined): string {
  if (!s) return "";
  return colapsarEspacios(quitarAcentos(s).toUpperCase().replace(/[^0-9A-ZÑ .;\-_/() ]/g, " ")).slice(0, 50).trim();
}

/** Cédula profesional (65, 97): 0-9 A-Z Ñ; si tiene menos de 6 caracteres se completa con ceros a la izquierda. */
export function normalizarCedula(s: string | null | undefined): string {
  if (!s) return "";
  const limpia = quitarAcentos(s).toUpperCase().replace(/[^0-9A-ZÑ]/g, "");
  if (!limpia) return "";
  return limpia.length < 6 ? limpia.padStart(6, "0") : limpia.slice(0, 14);
}

/** Folio numérico (2, 66, 68…): sólo dígitos. */
export const soloDigitos = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

/** dd/mm/aaaa en el reloj de piso (America/Mexico_City). */
export function fechaSaeh(d: Date | null | undefined): string {
  if (!d) return "";
  const { y, m, d: dia } = partesLocales(d);
  return `${String(dia).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}

/** Peso en kilogramos con formato ###.###; 999 = se desconoce. */
export function pesoSaeh(peso: number | null | undefined): string {
  if (peso == null || !Number.isFinite(peso)) return "";
  if (peso === 999) return "999";
  return peso.toFixed(3);
}

/** «HH:MM» válido entre 00:01 y 48:00, o 99:99 (no especificado). */
export function tiempoQuirofanoValido(t: string | null | undefined): boolean {
  if (!t) return false;
  if (t === "99:99") return true;
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) return false;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (mm > 59) return false;
  const minutos = hh * 60 + mm;
  return minutos >= 1 && minutos <= 48 * 60;
}

/** Minutos → «HH:MM» acotado al rango de la GIIS (00:01 a 48:00). */
export function tiempoQuirofanoDeMinutos(minutos: number): string {
  const total = Math.max(1, Math.min(48 * 60, Math.round(minutos)));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Texto en minúsculas sin acentos para comparar nombres de catálogo («Puebla» ↔ «PUEBLA»). */
export function claveComparable(s: string | null | undefined): string {
  return quitarAcentos(s ?? "")
    .toUpperCase()
    .replace(/[^0-9A-ZÑ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Letras y dígitos, sin acentos ni signos ni espacios: lo que no puede perderse al normalizar. */
const esqueleto = (s: string) => quitarAcentos(s).toUpperCase().replace(/[^0-9A-ZÑ]/g, "");

/**
 * True si la normalización perdió letras o dígitos (caracteres no admitidos,
 * truncado a la longitud máxima). Mayúsculas, acentos, signos y espacios no
 * cuentan: eso es lo que la GIIS pide quitar y no amerita aviso.
 */
export function perdidaAlNormalizar(original: string, normalizado: string): boolean {
  return esqueleto(original) !== esqueleto(normalizado);
}
