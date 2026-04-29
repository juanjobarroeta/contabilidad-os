/**
 * Default weekly distribution curves for vivienda 2R / 3R projects.
 * Extracted from Decolsa's PROGRAMA FÍSICO FINANCIERO standard template
 * (Torres Platino 2R, 48 weeks, 30 capítulos).
 *
 * Used to bootstrap the EstimacionCurvaCapitulo rows when a presupuesto is
 * imported. Gerardo can edit per-curve or per-week afterwards.
 *
 * Each curve's weekly array sums to 1.0 — that capítulo's 100% gets
 * distributed across the active weeks. Inactive weeks are 0. Trailing
 * zeros stripped here for readability; server pads to project.weekCount.
 */

export type CurvaDefault = {
  capituloCode: string;
  descripcion: string;
  pesoPctSemanal: number[]; // length ≤ 48; sum ≈ 1.0
};

export const CURVA_VIVIENDA_2R_DEFAULT: CurvaDefault[] = [
  { capituloCode: "1", descripcion: "LOSA DE CIMENTACIÓN", pesoPctSemanal: [0.05, 0.1, 0.1, 0.15, 0.25, 0.2, 0.15] },
  { capituloCode: "2", descripcion: "PLANTA BAJA", pesoPctSemanal: [0, 0, 0, 0.1, 0.1, 0.2, 0.2, 0.15, 0.15, 0.1] },
  { capituloCode: "3", descripcion: "LOSA DE ENTREPISO (PB - 1N)", pesoPctSemanal: [0, 0, 0, 0, 0.07, 0.15, 0.2, 0.15, 0.15, 0.15, 0.13] },
  { capituloCode: "4", descripcion: "PRIMER NIVEL", pesoPctSemanal: [0, 0, 0, 0, 0, 0.1, 0.1, 0.2, 0.2, 0.15, 0.15, 0.1] },
  { capituloCode: "5", descripcion: "LOSA DE ENTREPISO (1N - 2N)", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0.07, 0.15, 0.2, 0.15, 0.15, 0.15, 0.13] },
  { capituloCode: "6", descripcion: "SEGUNDO NIVEL", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0.1, 0.1, 0.2, 0.2, 0.15, 0.15, 0.1] },
  { capituloCode: "7", descripcion: "LOSA DE ENTREPISO (2N - 3N)", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0.07, 0.15, 0.2, 0.15, 0.15, 0.15, 0.13] },
  { capituloCode: "8", descripcion: "TERCER NIVEL", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.1, 0.2, 0.2, 0.15, 0.15, 0.1] },
  { capituloCode: "9", descripcion: "LOSA DE ENTREPISO (3N - 4N)", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.07, 0.15, 0.2, 0.15, 0.15, 0.15, 0.13] },
  { capituloCode: "10", descripcion: "CUARTO NIVEL", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.1, 0.2, 0.2, 0.15, 0.15, 0.1] },
  { capituloCode: "11", descripcion: "LOSA DE AZOTEA (4N - AZOTEA)", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.07, 0.15, 0.2, 0.15, 0.15, 0.15, 0.13] },
  { capituloCode: "12", descripcion: "TRABAJOS EN AZOTEA", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.1, 0.2, 0.2, 0.15, 0.15, 0.1] },
  { capituloCode: "13", descripcion: "IMPERMEABILIZACIÓN", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.35, 0.25, 0.2, 0.1] },
  { capituloCode: "14", descripcion: "ALBAÑILERÍA INTERIOR", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0.05, 0.05, 0.05, 0.07, 0.07, 0.07, 0.08, 0.08, 0.08, 0.08, 0.07, 0.07, 0.07, 0.06, 0.05] },
  { capituloCode: "15", descripcion: "ACABADOS INTERIORES", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.05, 0.05, 0.06, 0.1, 0.1, 0.1, 0.1, 0.08, 0.08, 0.05, 0.06, 0.05, 0.03, 0.03, 0.03, 0.03] },
  { capituloCode: "16", descripcion: "ACABADOS EXTERIORES", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.06, 0.05, 0.05, 0.1, 0.1, 0.1, 0.09, 0.08, 0.08, 0.05, 0.05, 0.05, 0.04, 0.04, 0.03, 0.03] },
  { capituloCode: "17", descripcion: "PUERTAS // CARPINTERÍA", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0.01, 0.01, 0.01, 0.02, 0.03, 0.03, 0.03, 0.08, 0.15, 0.19, 0.19, 0.07, 0.06, 0.06, 0.06] },
  { capituloCode: "18", descripcion: "CANCELERÍA DE ALUMINIO", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.15, 0.19, 0.19, 0.19, 0.14, 0.09, 0.05] },
  { capituloCode: "19", descripcion: "MUEBLES DE BAÑO", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0.3, 0.25, 0.1, 0.05] },
  { capituloCode: "20", descripcion: "PARTIDA ECOLÓGICA", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.27, 0.27, 0.3, 0.1, 0.06] },
  { capituloCode: "21", descripcion: "HERRERÍA", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.12, 0.12, 0.12, 0.12, 0.12, 0.11, 0.08] },
  { capituloCode: "22", descripcion: "ESCALERA METALICA", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0.06, 0.06, 0.06, 0.06, 0.06, 0.06, 0.06, 0.06, 0.06, 0.06, 0.06, 0.06, 0.06, 0.06, 0.06, 0.05, 0.05] },
  { capituloCode: "23", descripcion: "NICHO DE MEDICIÓN", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0.3, 0.1, 0.15, 0.15] },
  { capituloCode: "24", descripcion: "NICHO DE GAS", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0.3, 0.25, 0.1, 0.05] },
  { capituloCode: "25", descripcion: "PISO Y ÁREA VERDE (ÁREA COMÚN VESTÍBULO)", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.15, 0.35, 0.35, 0.1, 0.05] },
  { capituloCode: "26", descripcion: "BARDAS DE PATIO TRASERO DE PLANTA BAJA", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2, 0.2, 0.2, 0.1, 0.15, 0.1, 0.05] },
  { capituloCode: "27", descripcion: "LIMPIEZA", pesoPctSemanal: [0, 0, 0, 0.04, 0.04, 0.04, 0.04, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.03, 0.03, 0.03, 0.03, 0.02] },
  { capituloCode: "28", descripcion: "INSTALACIONES", pesoPctSemanal: [0, 0.03, 0.03, 0.03, 0.03, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.03, 0.07, 0.1, 0.1, 0.1, 0.1, 0.04, 0.05, 0.04, 0.03] },
  { capituloCode: "29", descripcion: "NOMENCLATURA DE EDIFICIOS", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.25, 0.25, 0.25, 0.25] },
  { capituloCode: "30", descripcion: "JAULAS DE TENDIDO", pesoPctSemanal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.08, 0.3, 0.3, 0.2, 0.06, 0.06] },
];

export const CURVA_DEFAULT_WEEK_COUNT = 48;
