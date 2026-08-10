// ─────────────────────────────────────────────────────────────────────────────
// ¿Este contribuyente presenta declaración ANUAL de ISR?
//
// La excepción que motivó esto: RESICO Persona Física (régimen 626). Desde la
// reforma al Art. 113-E LISR sus pagos mensuales son DEFINITIVOS y NO presenta
// declaración anual — pero la CSF del SAT muchas veces sigue listando la
// obligación anual, y nuestro checklist además la infería de "tiene ISR".
// Resultado real: el agente de WhatsApp le cobró a una cliente RESICO una
// "anual 2025 vencida" que no existe.
//
// OJO: la exención es SOLO para persona física. RESICO de Personas Morales
// (mismo código 626 en el catálogo) SÍ presenta anual (Título VII Cap. XII).
// PF se distingue por el RFC de 13 caracteres.
//
// Función PURA: recibe los códigos de régimen y si es PF; no toca BD.
// ─────────────────────────────────────────────────────────────────────────────

/** Regímenes PF cuyos pagos mensuales son definitivos — sin anual de ISR. */
const REGIMENES_PF_SIN_ANUAL = new Set(["626"]);

export function requiereDeclaracionAnual(args: {
  /** Códigos de régimen de la empresa (principal + adicionales, con o sin duplicados). */
  regimenes: Array<string | null | undefined>;
  esPersonaFisica: boolean;
}): boolean {
  const codes = [...new Set(args.regimenes.filter((c): c is string => !!c && c.trim() !== ""))];
  // Sin información de régimen: no afirmar la exención — pedir la anual es el
  // default seguro (nag de más, nunca obligación invisible).
  if (codes.length === 0) return true;
  if (!args.esPersonaFisica) return true;
  // La exención sólo aplica si TODOS los regímenes son exentos: una PF con
  // RESICO + arrendamiento (626+606) sí presenta anual por el otro régimen.
  return !codes.every((c) => REGIMENES_PF_SIN_ANUAL.has(c));
}

/** PF ⇔ RFC de 13 caracteres (PM: 12). */
export function esPersonaFisicaRfc(rfc: string | null | undefined): boolean {
  return (rfc ?? "").trim().length === 13;
}
