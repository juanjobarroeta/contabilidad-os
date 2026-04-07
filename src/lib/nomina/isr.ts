// ─────────────────────────────────────────────────────────────────────────────
// ISR retención por sueldos — Tarifa Art. 96 LISR + Subsidio para el Empleo
//
// Tarifas vigentes 2024-2026 publicadas por SAT. Si SAT actualiza las tarifas
// (típicamente 1 enero), hay que actualizar las dos constantes de abajo.
//
// Reference:
//   https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=...
// ─────────────────────────────────────────────────────────────────────────────

type TarifaRow = {
  limiteInferior: number;
  limiteSuperior: number;
  cuotaFija: number;
  porcentaje: number; // decimal, e.g. 0.064 = 6.4%
};

// Tarifa MENSUAL (Art. 96 LISR)
const TARIFA_MENSUAL: TarifaRow[] = [
  { limiteInferior: 0.01,        limiteSuperior: 746.04,     cuotaFija: 0.00,      porcentaje: 0.0192 },
  { limiteInferior: 746.05,      limiteSuperior: 6332.05,    cuotaFija: 14.32,     porcentaje: 0.0640 },
  { limiteInferior: 6332.06,     limiteSuperior: 11128.01,   cuotaFija: 371.83,    porcentaje: 0.1088 },
  { limiteInferior: 11128.02,    limiteSuperior: 12935.82,   cuotaFija: 893.63,    porcentaje: 0.1600 },
  { limiteInferior: 12935.83,    limiteSuperior: 15487.71,   cuotaFija: 1182.88,   porcentaje: 0.1792 },
  { limiteInferior: 15487.72,    limiteSuperior: 31236.49,   cuotaFija: 1640.18,   porcentaje: 0.2136 },
  { limiteInferior: 31236.50,    limiteSuperior: 49233.00,   cuotaFija: 5004.12,   porcentaje: 0.2352 },
  { limiteInferior: 49233.01,    limiteSuperior: 93993.90,   cuotaFija: 9236.89,   porcentaje: 0.3000 },
  { limiteInferior: 93993.91,    limiteSuperior: 125325.20,  cuotaFija: 22665.17,  porcentaje: 0.3200 },
  { limiteInferior: 125325.21,   limiteSuperior: 375975.61,  cuotaFija: 32691.18,  porcentaje: 0.3400 },
  { limiteInferior: 375975.62,   limiteSuperior: Infinity,   cuotaFija: 117912.32, porcentaje: 0.3500 },
];

// Subsidio para el empleo (tabla mensual)
type SubsidioRow = { limiteInferior: number; limiteSuperior: number; subsidio: number };
const SUBSIDIO_MENSUAL: SubsidioRow[] = [
  { limiteInferior: 0.01,    limiteSuperior: 1768.96, subsidio: 407.02 },
  { limiteInferior: 1768.97, limiteSuperior: 2653.38, subsidio: 406.83 },
  { limiteInferior: 2653.39, limiteSuperior: 3472.84, subsidio: 406.62 },
  { limiteInferior: 3472.85, limiteSuperior: 3537.87, subsidio: 392.77 },
  { limiteInferior: 3537.88, limiteSuperior: 4446.15, subsidio: 382.46 },
  { limiteInferior: 4446.16, limiteSuperior: 4717.18, subsidio: 354.23 },
  { limiteInferior: 4717.19, limiteSuperior: 5335.42, subsidio: 324.87 },
  { limiteInferior: 5335.43, limiteSuperior: 6224.67, subsidio: 294.63 },
  { limiteInferior: 6224.68, limiteSuperior: 7113.90, subsidio: 253.54 },
  { limiteInferior: 7113.91, limiteSuperior: 7382.33, subsidio: 217.61 },
  { limiteInferior: 7382.34, limiteSuperior: Infinity, subsidio: 0 },
];

function applyTarifa(base: number, tarifa: TarifaRow[]): number {
  if (base <= 0) return 0;
  const row = tarifa.find((r) => base >= r.limiteInferior && base <= r.limiteSuperior);
  if (!row) return 0;
  const excedente = base - row.limiteInferior;
  return row.cuotaFija + excedente * row.porcentaje;
}

function applySubsidio(base: number, tabla: SubsidioRow[]): number {
  if (base <= 0) return 0;
  const row = tabla.find((r) => base >= r.limiteInferior && base <= r.limiteSuperior);
  return row?.subsidio ?? 0;
}

// Periodicidad → factor para convertir base del periodo a base mensual
// (la tarifa está en mensual; convertimos primero, calculamos, luego dividimos
// proporcionalmente para devolver el ISR del periodo).
const PERIODICIDAD_FACTOR: Record<string, number> = {
  "01": 1 / 7,    // Diario
  "02": 7 / 30.4, // Semanal (~7 días)
  "03": 14 / 30.4,// Catorcenal
  "04": 15 / 30.4,// Quincenal
  "05": 1,        // Mensual
  "06": 2,        // Bimestral
  "07": 4 / 30.4, // Por unidad de obra (≈ semanal)
  "10": 1,        // Decenal — usar mensual como aproximación
  "99": 1,        // Otra
};

export type IsrCalcInput = {
  /** Monto bruto del periodo (sueldo + percepciones gravadas) */
  baseGravable: number;
  /** SAT periodicidad code: "04"=quincenal, "05"=mensual, etc. */
  periodicidadPago: string;
};

export type IsrCalcResult = {
  baseMensual: number;
  isrSegunTarifa: number;
  subsidio: number;
  isrRetenido: number;
};

/**
 * Calcula el ISR retenido por sueldos para un periodo dado.
 * 1. Convierte la base gravable a equivalente mensual
 * 2. Aplica la tarifa Art. 96 LISR
 * 3. Resta el subsidio para el empleo (si aplica)
 * 4. Convierte de vuelta a la proporción del periodo
 */
export function calcularIsrRetenido(input: IsrCalcInput): IsrCalcResult {
  const factor = PERIODICIDAD_FACTOR[input.periodicidadPago] ?? 1;
  const baseMensual = input.baseGravable / factor;

  const isrMensual = applyTarifa(baseMensual, TARIFA_MENSUAL);
  const subsidioMensual = applySubsidio(baseMensual, SUBSIDIO_MENSUAL);
  const retencionMensual = Math.max(0, isrMensual - subsidioMensual);

  // Pro-rata back to the period
  const isrRetenido = +(retencionMensual * factor).toFixed(2);

  return {
    baseMensual,
    isrSegunTarifa: +(isrMensual * factor).toFixed(2),
    subsidio: +(subsidioMensual * factor).toFixed(2),
    isrRetenido,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// IMSS obrero (cuotas a cargo del trabajador)
// Simplificado para v1: porcentaje plano del SBC × días pagados.
// Real-world: las cuotas IMSS son un cálculo escalonado por concepto
// (enfermedades, invalidez, retiro, etc.). El usuario corrige en SUA después.
// ─────────────────────────────────────────────────────────────────────────────

const IMSS_OBRERO_PCT = 0.025; // ≈ 2.5% del SBC (aproximación conservadora)

export function calcularImssObrero(salarioBaseCotizacion: number, diasPagados: number): number {
  return +((salarioBaseCotizacion * diasPagados) * IMSS_OBRERO_PCT).toFixed(2);
}
