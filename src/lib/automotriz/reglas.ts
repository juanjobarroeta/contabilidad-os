// ─────────────────────────────────────────────────────────────────────────────
// Motor de reglas aprendidas: aplica lo que el distribuidor ya confirmó.
//
// El orden de la clasificación es SIEMPRE el mismo y no se negocia:
//
//   1. objeto derivado   (la unidad, la orden, el kardex ya reclamaron el CFDI)
//   2. regla confirmada  (esto: lo que alguien de la agencia dijo una vez)
//   3. regla del catálogo (classifyEgreso / clasificarIngreso, iguales para todos)
//   4. pendiente         (nadie lo reclama: sale en el reporte de cobertura)
//
// La regla de la agencia gana sobre el catálogo genérico porque el catálogo del
// SAT no distingue lo que sí distingue el negocio (bono del distribuidor vs
// comisión de seguros bajo la misma clave 80141600). Nunca gana sobre un objeto
// derivado: si el CFDI ya ampara una unidad vendida, ninguna regla de texto
// debería poder moverlo de ahí.
//
// Entre reglas, gana la MÁS ESPECÍFICA — mismo criterio que classifyEgreso: el
// prefijo más largo primero, y a igualdad de prefijo la que además exige patrón.
// Así una regla fina («BONO INCREMENTAL») no queda tapada por una gruesa
// («8014»), sin importar en qué orden se hayan capturado.
// ─────────────────────────────────────────────────────────────────────────────

/** Longitud máxima de un patrón. Corta de raíz el regex kilométrico pegado. */
export const MAX_PATRON = 200;

export interface ReglaAplicable {
  id: string;
  ambito: string;
  clavePrefijo: string | null;
  patron: string | null;
  destino: string;
  etiqueta: string;
}

export interface ConceptoAClasificar {
  /** Tipo del CFDI: INGRESO | EGRESO | NOMINA. */
  tipo: string;
  /** ClaveProdServ del concepto dominante. */
  clave: string;
  /** Descripción del concepto dominante. */
  descripcion: string;
}

/**
 * Compila el patrón de una regla. Devuelve null si no compila o si excede el
 * largo máximo — una regla inválida se ignora, nunca tumba la clasificación de
 * todo el ejercicio.
 */
export function compilarPatron(patron: string | null | undefined): RegExp | null {
  if (!patron) return null;
  if (patron.length > MAX_PATRON) return null;
  try {
    return new RegExp(patron, "i");
  } catch {
    return null;
  }
}

/**
 * Valida una regla ANTES de guardarla. Devuelve el motivo del rechazo o null si
 * es válida. Se exige al menos un criterio: una regla con clavePrefijo y patron
 * en null empataría con todos los CFDIs de su ámbito y borraría el residuo en
 * vez de explicarlo — exactamente lo contrario de para qué existe el reporte.
 */
export function validarRegla(r: {
  ambito?: string | null;
  clavePrefijo?: string | null;
  patron?: string | null;
  destino?: string | null;
  etiqueta?: string | null;
}): string | null {
  if (!r.ambito || !["INGRESO", "EGRESO", "NOMINA"].includes(r.ambito)) {
    return "El ámbito debe ser INGRESO, EGRESO o NOMINA.";
  }
  if (!r.destino?.trim()) return "Falta el destino de la regla.";
  if (!r.etiqueta?.trim()) return "Falta la etiqueta legible de la regla.";
  const prefijo = r.clavePrefijo?.trim();
  const patron = r.patron?.trim();
  if (!prefijo && !patron) {
    return "Una regla necesita al menos un criterio: prefijo de clave o patrón de descripción.";
  }
  if (prefijo && !/^\d{2,8}$/.test(prefijo)) {
    return "El prefijo de clave debe ser de 2 a 8 dígitos del catálogo del SAT.";
  }
  if (patron) {
    if (patron.length > MAX_PATRON) return `El patrón no puede exceder ${MAX_PATRON} caracteres.`;
    if (!compilarPatron(patron)) return "El patrón no es una expresión regular válida.";
  }
  return null;
}

/** Especificidad: prefijo más largo primero; a igualdad, la que exige patrón. */
function especificidad(r: ReglaAplicable): number {
  return (r.clavePrefijo?.length ?? 0) * 2 + (r.patron ? 1 : 0);
}

export interface ReglaPreparada extends ReglaAplicable {
  re: RegExp | null;
}

/**
 * Ordena de más a menos específica y compila los patrones UNA vez. El reporte
 * evalúa cientos de clusters contra decenas de reglas; compilar dentro del
 * bucle multiplicaría el trabajo sin necesidad.
 *
 * Una regla con patrón que no compila se DESCARTA aquí, no más adelante: si
 * sobreviviera sin regex empataría por clave sola y clasificaría de más — el
 * modo de fallar de una regla rota tiene que ser no aplicar, nunca aplicar
 * más de lo que pide.
 */
export function prepararReglas(reglas: ReglaAplicable[]): ReglaPreparada[] {
  return reglas
    .map((r) => ({ ...r, re: compilarPatron(r.patron) }))
    .filter((r) => !r.patron || r.re !== null)
    .sort((a, b) => especificidad(b) - especificidad(a));
}

/**
 * Primera regla que empata con el concepto, o null. `reglas` debe venir de
 * `prepararReglas`.
 */
export function aplicarReglas(
  reglas: ReglaPreparada[],
  concepto: ConceptoAClasificar
): ReglaPreparada | null {
  for (const r of reglas) {
    if (r.ambito !== concepto.tipo) continue;
    if (r.clavePrefijo && !concepto.clave.startsWith(r.clavePrefijo)) continue;
    if (r.re && !r.re.test(concepto.descripcion)) continue;
    return r;
  }
  return null;
}
