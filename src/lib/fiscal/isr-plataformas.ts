// ─────────────────────────────────────────────────────────────────────────────
// ISR plataformas tecnológicas — Persona Física (régimen 625, Art. 113-A LISR).
//
// Las plataformas (transporte, entrega, hospedaje, marketplaces) RETIENEN el
// ISR a tasa fija sobre los ingresos SIN IVA, y lo enteran. Para la PF cuyos
// ingresos por plataformas no exceden $300,000 al año y que opta por ello, esa
// retención es PAGO DEFINITIVO (no presenta más); en otro caso es provisional y
// acredita las retenciones contra el cálculo anual.
//
// Tasas vigentes desde 2021 (reforma DOF 09-dic-2019, vigente 2021; el esquema
// de tasa única sustituyó a la tabla escalonada original de 2020):
//   - Transporte terrestre de pasajeros y entrega de bienes ... 2.1%
//   - Servicios de hospedaje .................................. 4.0%
//   - Enajenación de bienes y prestación de servicios ......... 1.0%
//
// v1 (pago definitivo): ISR del mes = tasa × ingresos cobrados − retenciones
// efectivamente hechas por las plataformas (del desglose del CFDI). Cuando todo
// el ingreso pasó por plataforma, la retención iguala al causado y no hay nada
// más que pagar; el remanente corresponde a ingresos cobrados directamente de
// los usuarios (mismas tasas, Art. 113-A último párrafo), que sí entera la PF.
// ─────────────────────────────────────────────────────────────────────────────

export type PlataformaActividad = "transporte" | "hospedaje" | "servicios";

export interface TasaPlataforma {
  actividad: PlataformaActividad;
  tasa: number;
  label: string;
}

export const TASAS_PLATAFORMA: Record<PlataformaActividad, TasaPlataforma> = {
  transporte: { actividad: "transporte", tasa: 0.021, label: "Transporte de pasajeros y entrega de bienes" },
  hospedaje: { actividad: "hospedaje", tasa: 0.04, label: "Servicios de hospedaje" },
  servicios: { actividad: "servicios", tasa: 0.01, label: "Enajenación de bienes y prestación de servicios" },
};

/** Normaliza el valor guardado en Company.plataformaActividad a una actividad válida. */
export function normalizarActividadPlataforma(raw: string | null | undefined): PlataformaActividad {
  if (raw === "transporte" || raw === "hospedaje" || raw === "servicios") return raw;
  return "servicios"; // default conservador (tasa más baja); el motor lo señala
}

export interface IsrPlataformasInput {
  /** Ingresos por plataformas efectivamente cobrados en el mes (sin IVA). */
  ingresosCobradosMes: number;
  /** ISR retenido por las plataformas sobre esos ingresos (del CFDI). */
  retencionesMes?: number;
  actividad: PlataformaActividad;
}

export interface IsrPlataformasResult {
  ingresos: number;
  actividad: PlataformaActividad;
  tasa: number;
  isrCausado: number;
  retenciones: number;
  isrPagar: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * ISR definitivo mensual del régimen de plataformas (Art. 113-A): tasa fija ×
 * ingresos cobrados − retenciones de las plataformas.
 */
export function calcularIsrPlataformas(input: IsrPlataformasInput): IsrPlataformasResult {
  const ingresos = Math.max(0, input.ingresosCobradosMes);
  const { tasa } = TASAS_PLATAFORMA[input.actividad];
  const isrCausado = r2(ingresos * tasa);
  const retenciones = r2(input.retencionesMes ?? 0);
  const isrPagar = Math.max(0, r2(isrCausado - retenciones));
  return { ingresos: r2(ingresos), actividad: input.actividad, tasa, isrCausado, retenciones, isrPagar };
}
