// ─────────────────────────────────────────────────────────────────────────────
// Qué códigos del Anexo 24 PODRÍA llevar una cuenta. Puro.
//
// Cuando una cuenta no trae agrupador en ningún catálogo presentado, alguien
// tiene que elegirlo. El copiloto puede razonar cuál encaja — pero no debe
// inventarse el código: los 1053 del Anexo 24 son una lista cerrada y un
// código que no existe hace que el SAT rechace la Contabilidad Electrónica.
//
// Así que aquí se acota la lista a lo que de verdad puede aplicar (la clase de
// la cuenta manda: 1xx activo, 2xx pasivo, 3xx capital, 4xx ingresos, 5xx
// costos, 6xx gastos…) y se ordena por parecido de nombre. El modelo escoge de
// esta baraja y explica por qué; nunca escribe un código de su memoria.
// ─────────────────────────────────────────────────────────────────────────────

import { CODIGO_AGRUPADOR_OFICIAL } from "./codigo-agrupador";

export type TipoCuenta = "ACTIVO" | "PASIVO" | "CAPITAL" | "INGRESO" | "GASTO" | "COSTO";

/**
 * Primer dígito del agrupador por clase de cuenta. Un gasto también puede
 * clasificarse como resultado integral de financiamiento (7xx) — intereses,
 * cambiario— y como cuenta de orden (8xx), así que esas clases aceptan más de
 * un prefijo. El orden importa: el primero es el natural.
 */
export const PREFIJOS_POR_TIPO: Record<TipoCuenta, string[]> = {
  ACTIVO: ["1"],
  PASIVO: ["2"],
  CAPITAL: ["3"],
  INGRESO: ["4", "7"],
  COSTO: ["5"],
  GASTO: ["6", "7"],
};

export interface CandidatoAgrupador {
  codigo: string;
  nombre: string;
  /** Cuántas palabras del nombre de la cuenta aparecen en el del agrupador. */
  coincidencias: number;
}

/** Palabras que no distinguen nada y sólo ensucian el parecido. */
const VACIAS = new Set([
  "de", "del", "la", "las", "el", "los", "y", "o", "a", "en", "por", "para",
  "con", "sin", "su", "sus", "un", "una", "al", "cuenta", "cuentas",
]);

/** Normaliza para comparar: sin acentos, minúsculas, sólo letras y dígitos. */
export function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function palabras(s: string): string[] {
  return normalizar(s)
    .split(" ")
    .filter((w) => w.length > 2 && !VACIAS.has(w));
}

/**
 * Códigos del Anexo 24 que podrían corresponder a esta cuenta, del más parecido
 * al menos. Sólo de la clase que le toca por su tipo — un gasto nunca es un
 * activo, por mucho que el nombre se parezca.
 *
 * Devuelve SIEMPRE algo (aunque ninguna palabra coincida): la clase completa es
 * mejor que una lista vacía, porque el trabajo del contador es escoger de ahí.
 */
export function candidatosAgrupador(
  cuenta: { nombre: string; tipo: TipoCuenta },
  opts: { max?: number } = {},
): CandidatoAgrupador[] {
  const max = opts.max ?? 25;
  const prefijos = PREFIJOS_POR_TIPO[cuenta.tipo] ?? [];
  const claves = palabras(cuenta.nombre);

  const dentro = Object.entries(CODIGO_AGRUPADOR_OFICIAL).filter(([codigo]) =>
    prefijos.some((p) => codigo.startsWith(p)),
  );

  const puntuados = dentro.map(([codigo, nombre]) => {
    const suyas = new Set(palabras(nombre));
    let coincidencias = 0;
    for (const w of claves) if (suyas.has(w)) coincidencias++;
    return { codigo, nombre, coincidencias };
  });

  puntuados.sort(
    (a, b) =>
      b.coincidencias - a.coincidencias ||
      // A igualdad, el más específico primero (una subcuenta 102.01 dice más
      // que el mayor 102), y luego por código para que sea determinista.
      b.codigo.length - a.codigo.length ||
      a.codigo.localeCompare(b.codigo),
  );

  const conParecido = puntuados.filter((c) => c.coincidencias > 0);
  return (conParecido.length > 0 ? conParecido : puntuados).slice(0, max);
}
