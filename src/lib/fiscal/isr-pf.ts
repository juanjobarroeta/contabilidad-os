import { tarifaPeriodoPF, aplicarTarifa } from "./tarifas";

// ─────────────────────────────────────────────────────────────────────────────
// ISR provisional — Persona Física con Actividad Empresarial y Profesional
// (régimen 612, Art. 106 LISR).
//
// Diferente de personas morales (Art. 14, coeficiente × 30%): la base es la
// utilidad real en FLUJO DE EFECTIVO —
//   ingresos efectivamente cobrados (ene→mes)
//   − deducciones autorizadas efectivamente pagadas (ene→mes)
//   − PTU pagada en el ejercicio
//   − pérdidas fiscales de ejercicios anteriores pendientes
// a la que se aplica la TARIFA del Art. 96 elevada al número de meses del
// periodo, y de la que se restan los pagos provisionales previos y las
// retenciones (10% que efectúan las personas morales, Art. 106).
//
// Esta función es pura: el llamador provee las bases ya calculadas (cobrado/
// pagado). NO asume devengado.
// ─────────────────────────────────────────────────────────────────────────────

export interface IsrProvisionalPfInput {
  ejercicio: number;
  /** Meses transcurridos del ejercicio hasta el periodo (1 = enero, …). */
  meses: number;
  ingresosCobradosAcum: number;
  deduccionesPagadasAcum: number;
  ptuPagada?: number;
  perdidasFiscales?: number;
  pagosProvisionalesAnteriores?: number;
  retencionesAcum?: number;
}

export interface IsrProvisionalPfResult {
  baseGravable: number;
  isrCausado: number;
  pagosProvisionalesAnteriores: number;
  retencionesAcum: number;
  isrPagar: number;
  /** Vigencia + provenance of the tarifa used, so the caller can flag trust. */
  tarifaEjercicio: number;
  tarifaFuente: string;
  tarifaVerificada: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Compute the PF actividad-empresarial provisional ISR. Returns null only when
 * no tarifa is available for the ejercicio (the caller should then report "ISR
 * no calculado" rather than guess).
 */
export function calcularIsrProvisionalPf(
  input: IsrProvisionalPfInput
): IsrProvisionalPfResult | null {
  const periodo = tarifaPeriodoPF(input.ejercicio, input.meses);
  if (!periodo) return null;

  const baseGravable = Math.max(
    0,
    input.ingresosCobradosAcum -
      input.deduccionesPagadasAcum -
      (input.ptuPagada ?? 0) -
      (input.perdidasFiscales ?? 0)
  );

  const isrCausado = r2(aplicarTarifa(baseGravable, periodo.tarifa));
  const pagosProvisionalesAnteriores = input.pagosProvisionalesAnteriores ?? 0;
  const retencionesAcum = input.retencionesAcum ?? 0;
  const isrPagar = Math.max(0, r2(isrCausado - pagosProvisionalesAnteriores - retencionesAcum));

  return {
    baseGravable: r2(baseGravable),
    isrCausado,
    pagosProvisionalesAnteriores: r2(pagosProvisionalesAnteriores),
    retencionesAcum: r2(retencionesAcum),
    isrPagar,
    tarifaEjercicio: periodo.base.ejercicio,
    tarifaFuente: periodo.base.fuente,
    tarifaVerificada: periodo.base.verificado,
  };
}
