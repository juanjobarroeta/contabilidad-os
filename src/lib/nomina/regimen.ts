// ─────────────────────────────────────────────────────────────────────────────
// c_TipoRegimen del complemento de nómina (Anexo 20 / catálogo SAT).
//
// Asimilados a salarios = régimen 05–11 (Art. 94 LISR): el retenedor retiene el
// ISR; el receptor acredita esa retención y declara el ingreso por este régimen
// — NO como sueldos y salarios (02). Distinguirlos importa para reconocer el
// ingreso por asimilados, su ISR retenido acreditable y su tratamiento anual.
// ─────────────────────────────────────────────────────────────────────────────

export const REGIMEN_NOMINA: Record<string, string> = {
  "02": "Sueldos y salarios",
  "03": "Jubilados",
  "04": "Pensionados",
  "05": "Asimilados — miembros soc. cooperativas",
  "06": "Asimilados — integrantes soc./asoc. civiles",
  "07": "Asimilados — miembros consejos/administradores",
  "08": "Asimilados — comisionistas",
  "09": "Asimilados — honorarios",
  "10": "Asimilados — acciones o títulos valor",
  "11": "Asimilados — otros",
  "12": "Jubilados o pensionados",
  "13": "Indemnización o separación",
  "99": "Otro régimen",
};

const ASIMILADOS = new Set(["05", "06", "07", "08", "09", "10", "11"]);

/** True si el régimen de nómina es alguno de los asimilados a salarios (Art. 94). */
export function esAsimilado(regimen: string | null | undefined): boolean {
  return !!regimen && ASIMILADOS.has(regimen);
}

/** Etiqueta legible del régimen; null si no hay régimen. */
export function etiquetaRegimenNomina(regimen: string | null | undefined): string | null {
  if (!regimen) return null;
  return REGIMEN_NOMINA[regimen] ?? `Régimen ${regimen}`;
}
