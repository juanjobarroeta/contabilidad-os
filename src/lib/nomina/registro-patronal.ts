// ─────────────────────────────────────────────────────────────────────────────
// Registro Patronal IMSS — normalización, validación y resolución por empleado.
//
// Caso real que motivó esto (Grupo Asturcar): una empresa con operaciones en
// varios estados tiene UN registro patronal POR ESTADO, pero el modelo sólo
// tenía Company.registroPatronal. Y el campo aceptaba cualquier cosa — un
// cliente guardó su CORREO ELECTRÓNICO como registro patronal y nada lo
// detuvo hasta que el timbrado de nómina hubiera salido mal.
//
// El registro patronal del IMSS son 11 caracteres alfanuméricos (típicamente
// una letra de la modalidad + 10 dígitos, p. ej. "A7025105103"). La gente lo
// captura con espacios o guiones ("A70 25105 10-3"): se normaliza quitándolos,
// no rechazándolos.
//
// Resolución por empleado: el registro EFECTIVO es el del empleado si lo tiene
// (su centro de trabajo), y si no, el de la empresa. Así una empresa con un
// solo registro no captura nada extra, y una multi-estado asigna por empleado.
// ─────────────────────────────────────────────────────────────────────────────

/** Largo exacto del registro patronal IMSS. */
export const LARGO_REGISTRO_PATRONAL = 11;

/**
 * Normaliza lo capturado: mayúsculas y sin espacios/guiones/puntos internos.
 * Devuelve null si queda vacío. NO valida — sólo limpia.
 */
export function normalizarRegistroPatronal(valor: string | null | undefined): string | null {
  const limpio = (valor ?? "").toUpperCase().replace(/[\s.\-–]/g, "");
  return limpio.length > 0 ? limpio : null;
}

/** ¿El valor (ya normalizable) tiene la forma de un registro patronal válido? */
export function registroPatronalValido(valor: string | null | undefined): boolean {
  const n = normalizarRegistroPatronal(valor);
  return n !== null && new RegExp(`^[A-Z0-9]{${LARGO_REGISTRO_PATRONAL}}$`).test(n);
}

/**
 * Mensaje de error en español para un valor inválido, o null si es válido.
 * Distingue el error real del usuario (pegó otra cosa en el campo) del error
 * de dedo (largo incorrecto), porque se corrigen distinto.
 */
export function errorRegistroPatronal(valor: string | null | undefined): string | null {
  const crudo = (valor ?? "").trim();
  if (crudo.length === 0) return null; // vacío es "sin capturar", no inválido
  if (crudo.includes("@")) {
    return "Eso parece un correo electrónico. El Registro Patronal IMSS son 11 caracteres (letra + 10 dígitos) y aparece en tu Tarjeta de Identificación Patronal.";
  }
  const n = normalizarRegistroPatronal(crudo)!;
  if (!/^[A-Z0-9]+$/.test(n)) {
    return "El Registro Patronal sólo lleva letras y números (11 caracteres, como en tu Tarjeta de Identificación Patronal).";
  }
  if (n.length !== LARGO_REGISTRO_PATRONAL) {
    return `El Registro Patronal IMSS tiene ${LARGO_REGISTRO_PATRONAL} caracteres y capturaste ${n.length}. Revísalo contra tu Tarjeta de Identificación Patronal.`;
  }
  return null;
}

/**
 * Registro patronal EFECTIVO de un empleado: el suyo si lo tiene (empresas con
 * un registro por estado/centro de trabajo), si no el de la empresa.
 */
export function registroPatronalEfectivo(
  empleado: { registroPatronal?: string | null },
  empresa: { registroPatronal?: string | null }
): string | null {
  return (
    normalizarRegistroPatronal(empleado.registroPatronal) ??
    normalizarRegistroPatronal(empresa.registroPatronal)
  );
}
