"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos, constantes y helpers compartidos del hub de Nómina. Extraídos del
// antiguo workspace /nomina/detalle al partirlo en pestañas (Corridas,
// Empleados) — la lógica es idéntica, sólo cambió de archivo.
// ─────────────────────────────────────────────────────────────────────────────

export interface PayrollItemDetail {
  id: string;
  employeeId: string;
  sueldoBase: number;
  horasExtra: number;
  bonosPagoFijo: number;
  bonosPagoVar: number;
  vales: number;
  otrasPercepciones: number;
  isrRetenido: number;
  imssObrero: number;
  imssPatronal: number;
  infonavit: number;
  otrasDeducc: number;
  aguinaldo: number;
  primaVacacional: number;
  vacaciones: number;
  ptu: number;
  totalPercepciones: number;
  totalDeducciones: number;
  netoAPagar: number;
  cfdiUuid: string | null;
  employee: { nombre: string; apellidoPaterno: string; rfc: string };
}

// Suma de percepciones extra (sobre el sueldo base): horas extra, bonos fijos y
// variables, vales y otras. Es lo que convierte "ver un nombre" en "ver la nómina".
export function percepExtra(i: PayrollItemDetail): number {
  return i.horasExtra + i.bonosPagoFijo + i.bonosPagoVar + i.vales + i.otrasPercepciones;
}

// ── PayrollRun types ─────────────────────────────────────────────────────────
export interface PayrollRun {
  id: string;
  periodo: string;
  fechaPago: string;
  tipo: string;
  status: string;
  totalPercepciones: number;
  totalDeducciones: number;
  totalNeto: number;
  extraData: Record<string, unknown> | null;
  /** "APP" = creada en la app; "SAT" = importada del histórico timbrado (sólo lectura). */
  origen?: string;
  createdAt: string;
  _count?: { items: number };
}

/** Respuesta de GET /api/nomina/run/prefill — insumos de la siguiente corrida. */
export interface RunPrefill {
  basadoEnRunId: string;
  basadoEnPeriodo: string;
  tipo: string;
  periodicidad: string;
  periodoInicio: string;
  periodoFin: string;
  fechaPago: string;
  diasPagados: number;
  employeeIds: string[];
  omitidosPorBaja: number;
}

export interface Incidencia {
  id: string;
  tipo: string;
  fecha: string;
  fechaFin: string | null;
  dias: number;
  horas: number | null;
  horasTriples: number | null;
  monto: number | null;
  notas: string | null;
  periodo: string | null;
  employee: { nombre: string; apellidoPaterno: string; rfc: string };
}

/** Incidencia del periodo de una corrida (GET /api/nomina/run/[id]) — sin
 *  include de empleado: se cruza con los items por employeeId. */
export interface RunIncidencia {
  id: string;
  employeeId: string;
  tipo: string;
  fecha: string;
  fechaFin: string | null;
  dias: number;
  horas: number | null;
  horasTriples: number | null;
  monto: number | null;
  ramoImss: string | null;
  notas: string | null;
}

export const TIPO_RUN_LABEL: Record<string, string> = {
  ORDINARIA: "Ordinaria",
  EXTRAORDINARIA: "Extraordinaria",
  FINIQUITO: "Finiquito",
  AGUINALDO: "Aguinaldo",
  VACACIONES: "Vacaciones",
  PTU: "PTU",
};

export const STATUS_RUN_LABEL: Record<string, string> = {
  DRAFT: "Borrador",
  CALCULATED: "Calculada",
  STAMPED: "Timbrada",
  PAID: "Pagada",
};

export const STATUS_RUN_COLOR: Record<string, string> = {
  DRAFT: "bg-cos-slate-tint text-cos-ink-soft",
  CALCULATED: "bg-cos-brand-tint text-cos-brand-ink",
  STAMPED: "bg-cos-jade-tint text-cos-jade-ink",
  PAID: "bg-cos-jade-tint text-cos-jade-ink",
};

export const INCIDENCIA_LABEL: Record<string, string> = {
  FALTA: "Falta",
  FALTA_JUSTIFICADA: "Falta justificada",
  INCAPACIDAD: "Incapacidad",
  PERMISO_CON_GOCE: "Permiso c/ goce",
  PERMISO_SIN_GOCE: "Permiso s/ goce",
  HORAS_EXTRA: "Horas extra",
  VACACIONES: "Vacaciones",
  RETARDO: "Retardo",
  BONO: "Bono / Destajo",
  COMISION: "Comisión",
  DESCUENTO: "Descuento",
};

// Tipos que requieren monto en pesos (percepciones/deducciones del periodo).
export const INCIDENCIA_CON_MONTO = ["BONO", "COMISION", "DESCUENTO"];
// Tipos que se capturan en días.
export const INCIDENCIA_CON_DIAS = [
  "FALTA", "FALTA_JUSTIFICADA", "INCAPACIDAD", "PERMISO_CON_GOCE", "PERMISO_SIN_GOCE", "VACACIONES",
];

export const RAMO_IMSS_LABEL: Record<string, string> = {
  "01": "Riesgo de trabajo",
  "02": "Enfermedad general",
  "03": "Maternidad",
};

export interface Employee {
  id: string;
  nombre: string;
  apellidoPaterno: string;
  apellidoMaterno: string | null;
  rfc: string;
  curp: string;
  nss: string;
  salarioDiario: number;
  salarioDiarioIntegrado: number | null;
  periodicidadPago: string;
  fechaIngreso: string;
  fechaBaja?: string | null;
  puesto: string | null;
  departamento: string | null;
  clabe: string | null;
  banco: string | null;
  isActive: boolean;
  /** Presente cuando la lista se pide con withUltimoRecibo=1. */
  ultimoRecibo?: { fechaPago: string; periodo: string; origen: string } | null;
}

// Bancos comunes en México para dispersión SPEI (consistente con el módulo de Bancos).
export const BANCOS = ["BBVA", "Banamex", "Santander", "Banorte", "HSBC", "Scotiabank", "Afirme", "Inbursa", "BanBajío", "Otro"];

export const PERIODICIDAD_LABEL: Record<string, string> = {
  "01": "Diario",
  "02": "Semanal",
  "03": "Catorcenal",
  "04": "Quincenal",
  "05": "Mensual",
  "06": "Bimestral",
  "10": "Decenal",
  "99": "Otro",
};

export const inputCls = "w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1">{label}</label>
      {children}
    </div>
  );
}
