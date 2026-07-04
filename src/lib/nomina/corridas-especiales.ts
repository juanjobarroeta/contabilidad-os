// ─────────────────────────────────────────────────────────────────────────────
// Corridas especiales de un toque: AGUINALDO y PTU.
//
// Vista previa por empleado (GET) + creación (POST) de la corrida con el
// motor de cálculo (calc-nomina). Los importes de la vista previa son
// ajustables ANTES de crear; los ajustes viajan como overrides y el motor
// rehace exención e ISR al crear — nunca se persisten impuestos capturados a
// mano.
//
// Base legal:
// - Aguinaldo: Art. 87 LFT — mínimo 15 días de salario, pagadero antes del
//   20 de diciembre; parte proporcional para quienes no cumplieron el año.
//   Exención: 30 UMA diarias (Art. 93 fracc. XIV LISR).
// - PTU: Arts. 117-131 LFT y 123 CPEUM — reparto del 10% de la renta
//   gravable, mitad por días trabajados y mitad por salarios devengados
//   (Art. 123 LFT), con tope individual de 3 meses de salario o el promedio
//   de la PTU de los últimos 3 años, lo más favorable (Art. 127 fracc. VIII,
//   reforma DOF 23-abr-2021). Pago dentro de los 60 días siguientes al
//   vencimiento de la declaración anual (Art. 122 LFT). Exención: 15 UMA
//   diarias (Art. 93 fracc. XIV LISR).
//
// SIMPLIFICACIONES DOCUMENTADAS:
// - Días trabajados: se derivan de fecha de alta (y baja) contra el ejercicio;
//   las faltas/incapacidades capturadas como incidencias no los reducen aquí.
// - Divisor 365 aun en bisiestos (convención de práctica generalizada).
// - Sólo empleados ACTIVOS: los ex-trabajadores con ≥ 60 días en el ejercicio
//   conservan derecho a PTU (Art. 127 fracc. VII LFT) pero requieren manejo
//   manual (no están en el roster activo).
// - Tope PTU: el promedio de 3 años sólo se usa cuando existen corridas PTU
//   previas (propias o importadas del SAT) en los 3 años de pago anteriores;
//   sin historial rige el tope de 3 meses de salario.
// - ISR: tarifa ordinaria mensual del Art. 96 LISR sobre el gravado; el
//   método opcional del Art. 174 RLISR es un pendiente documentado
//   (ver calc-nomina.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { calcularNomina } from "./calc-nomina";
import { repartirPtu, type RepartoPtuEmpleado } from "./ptu";
import { createPayrollRun, type PayrollRunResult } from "./payroll-run";
import {
  UMA_DIARIO,
  AGUINALDO_EXENTO_UMA,
  PTU_EXENTO_UMA,
  DIAS_AGUINALDO_MINIMO,
  umaDiariaDelEjercicio,
} from "./constants";
import type { Employee } from "@prisma/client";

const r2 = (n: number) => Math.round(n * 100) / 100;
const DIA_MS = 24 * 60 * 60 * 1000;

/** Fecha (UTC, sólo día) → timestamp UTC a medianoche. */
const diaUtc = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/**
 * Días trabajados DENTRO de un ejercicio (inclusive), de la fecha de alta a
 * la de baja (o al 31-dic). Tope 365 — en bisiestos el año completo también
 * reporta 365 (consistente con el divisor del Art. 87; simplificación
 * documentada).
 */
export function diasTrabajadosEnEjercicio(
  fechaIngreso: Date,
  fechaBaja: Date | null,
  ejercicio: number
): number {
  const inicioEj = Date.UTC(ejercicio, 0, 1);
  const finEj = Date.UTC(ejercicio, 11, 31);
  const inicio = Math.max(diaUtc(fechaIngreso), inicioEj);
  const fin = Math.min(fechaBaja ? diaUtc(fechaBaja) : finEj, finEj);
  if (fin < inicio) return 0;
  return Math.min(365, Math.floor((fin - inicio) / DIA_MS) + 1);
}

// ─── Aguinaldo ───────────────────────────────────────────────────────────────

export type AguinaldoPreviewRow = {
  employeeId: string;
  nombre: string;
  apellidoPaterno: string;
  rfc: string;
  salarioDiario: number;
  fechaIngreso: string;
  diasTrabajadosEjercicio: number;
  diasCorrespondientes: number;
  montoTotal: number;
  montoExento: number;
  montoGravado: number;
  isr: number;
  neto: number;
};

export type AguinaldoPreview = {
  ejercicio: number;
  diasAguinaldo: number;
  fechaPago: string;
  umaDiaria: number;
  topeExento: number; // 30 × UMA (Art. 93 fracc. XIV LISR)
  rows: AguinaldoPreviewRow[];
  tarifaWarning: string | null;
};

/** Fecha de pago por defecto del aguinaldo: 15 de diciembre (el Art. 87 LFT exige pagarlo antes del día 20). */
export function fechaPagoAguinaldoDefault(ejercicio: number): Date {
  return new Date(Date.UTC(ejercicio, 11, 15));
}

export async function previewAguinaldo(params: {
  companyId: string;
  ejercicio: number;
  diasAguinaldo?: number;
  fechaPago?: Date;
}): Promise<AguinaldoPreview> {
  const { companyId, ejercicio } = params;
  const diasAguinaldo = params.diasAguinaldo ?? DIAS_AGUINALDO_MINIMO;
  const fechaPago = params.fechaPago ?? fechaPagoAguinaldoDefault(ejercicio);
  const fechaCorte = new Date(Date.UTC(ejercicio, 11, 31));
  const umaDiaria = umaDiariaDelEjercicio(fechaPago.getUTCFullYear()) ?? UMA_DIARIO;

  const employees = await prisma.employee.findMany({
    where: { companyId, isActive: true },
    orderBy: [{ apellidoPaterno: "asc" }, { nombre: "asc" }],
  });

  let tarifasVerificadas = true;
  const rows: AguinaldoPreviewRow[] = employees.map((emp) => {
    const calc = calcularNomina({
      employee: emp as Employee & { tipoDescuentoInfonavit?: string | null },
      diasPagados: 0,
      tipo: "AGUINALDO",
      ejercicio: fechaPago.getUTCFullYear(),
      mes: fechaPago.getUTCMonth() + 1,
      diasAguinaldo,
      fechaCorte,
    });
    if (!calc.isrTarifaVerificada) tarifasVerificadas = false;
    const ag = calc.aguinaldoResult!;
    return {
      employeeId: emp.id,
      nombre: emp.nombre,
      apellidoPaterno: emp.apellidoPaterno,
      rfc: emp.rfc,
      salarioDiario: emp.salarioDiario,
      fechaIngreso: emp.fechaIngreso.toISOString().slice(0, 10),
      diasTrabajadosEjercicio: ag.diasTrabajadosEjercicio,
      diasCorrespondientes: ag.diasCorrespondientes,
      montoTotal: ag.montoTotal,
      montoExento: ag.montoExento,
      montoGravado: ag.montoGravado,
      isr: calc.isrRetenido,
      neto: calc.netoAPagar,
    };
  });

  return {
    ejercicio,
    diasAguinaldo,
    fechaPago: fechaPago.toISOString().slice(0, 10),
    umaDiaria,
    topeExento: r2(AGUINALDO_EXENTO_UMA * umaDiaria),
    rows,
    tarifaWarning: tarifasVerificadas
      ? null
      : "ISR calculado con tarifa/subsidio sin verificar para el ejercicio — cotejar antes de timbrar.",
  };
}

export async function crearCorridaAguinaldo(params: {
  companyId: string;
  ejercicio: number;
  diasAguinaldo?: number;
  fechaPago?: Date;
  /** Roster final de la vista previa; `monto` presente = ajuste manual. */
  items?: { employeeId: string; monto?: number }[];
}): Promise<PayrollRunResult> {
  const { companyId, ejercicio } = params;
  const diasAguinaldo = params.diasAguinaldo ?? DIAS_AGUINALDO_MINIMO;
  if (diasAguinaldo < DIAS_AGUINALDO_MINIMO) {
    return { ok: false, error: `El aguinaldo mínimo es de ${DIAS_AGUINALDO_MINIMO} días de salario (Art. 87 LFT).` };
  }
  const fechaPago = params.fechaPago ?? fechaPagoAguinaldoDefault(ejercicio);

  // items === undefined → todos los activos; items vacío = nadie incluido.
  if (params.items && params.items.length === 0) {
    return { ok: false, error: "No hay empleados incluidos en la corrida de aguinaldo." };
  }

  const aguinaldoMontos: Record<string, number> = {};
  for (const it of params.items ?? []) {
    if (it.monto != null) {
      if (!Number.isFinite(it.monto) || it.monto < 0) {
        return { ok: false, error: "Los montos ajustados de aguinaldo deben ser números no negativos." };
      }
      aguinaldoMontos[it.employeeId] = r2(it.monto);
    }
  }

  return createPayrollRun({
    companyId,
    tipo: "AGUINALDO",
    periodoInicio: new Date(Date.UTC(ejercicio, 0, 1)),
    periodoFin: new Date(Date.UTC(ejercicio, 11, 31)),
    fechaPago,
    // El aguinaldo no genera cotización IMSS del periodo (ya integra al SDI
    // vía el factor de integración, Art. 27 LSS) — 0 días de cotización.
    diasPagados: 0,
    diasAguinaldo,
    fechaCorte: new Date(Date.UTC(ejercicio, 11, 31)),
    employeeIds: params.items?.length ? params.items.map((i) => i.employeeId) : undefined,
    aguinaldoMontos: Object.keys(aguinaldoMontos).length ? aguinaldoMontos : undefined,
    ejercicio,
  });
}

// ─── PTU ─────────────────────────────────────────────────────────────────────

export type PtuPreviewRow = {
  employeeId: string;
  nombre: string;
  apellidoPaterno: string;
  rfc: string;
  salarioDiario: number;
  fechaIngreso: string;
  diasTrabajados: number;
  salarioDevengado: number;
  /** "RECIBOS" = suma de sueldo base de los recibos del ejercicio (app + SAT); "ESTIMADO" = salarioDiario × días (sin recibos). */
  fuenteSalario: "RECIBOS" | "ESTIMADO";
  promedioPtu3Anios: number | null;
  porDias: number;
  porSalario: number;
  brutoSinTope: number;
  topeIndividual: number;
  topado: boolean;
  montoTotal: number;
  montoExento: number;
  montoGravado: number;
  isr: number;
  neto: number;
};

export type PtuPreviewExcluido = {
  employeeId: string;
  nombre: string;
  apellidoPaterno: string;
  rfc: string;
  diasTrabajados: number;
  motivo: string;
  /** True si la exclusión fue manual (reversible en la vista previa). */
  manual: boolean;
};

export type PtuPreview = {
  ejercicio: number;
  montoTotal: number;
  fechaPago: string;
  umaDiaria: number;
  topeExento: number; // 15 × UMA (Art. 93 fracc. XIV LISR)
  rows: PtuPreviewRow[];
  excluidos: PtuPreviewExcluido[];
  totalAsignado: number;
  remanentePorTopes: number;
  tarifaWarning: string | null;
};

/**
 * Fecha de pago por defecto de la PTU: 30 de mayo del año siguiente al
 * ejercicio (Art. 122 LFT: dentro de los 60 días siguientes al vencimiento de
 * la declaración anual — personas morales declaran a más tardar el 31-mar;
 * para patrones persona física el plazo corre al 29-jun, editable).
 */
export function fechaPagoPtuDefault(ejercicio: number): Date {
  return new Date(Date.UTC(ejercicio + 1, 4, 30));
}

type DatosPtuEmpleado = {
  employee: Employee;
  diasTrabajados: number;
  salarioDevengado: number;
  fuenteSalario: "RECIBOS" | "ESTIMADO";
  promedioPtu3Anios: number | null;
};

/**
 * Insumos del reparto por empleado activo:
 * - Días trabajados en el ejercicio (alta/baja vs ejercicio).
 * - Salario devengado: sueldo base de los recibos del ejercicio (nativos e
 *   importados del SAT — misma base que acumulados.ts, año UTC de la fecha de
 *   pago). Sin recibos del ejercicio: estimado salarioDiario × días
 *   (documentado en `fuenteSalario`).
 * - Promedio de PTU de los últimos 3 años de pago anteriores a `anioPago`
 *   (renglón `ptu` de los recibos): promedio sobre los años en que sí hubo
 *   PTU; null sin historial → rige el tope de 3 meses.
 */
async function datosPtuEmpleados(
  companyId: string,
  ejercicio: number,
  anioPago: number,
  employeeIds?: string[]
): Promise<DatosPtuEmpleado[]> {
  const employees = await prisma.employee.findMany({
    where: {
      companyId,
      isActive: true,
      ...(employeeIds ? { id: { in: employeeIds } } : {}),
    },
    orderBy: [{ apellidoPaterno: "asc" }, { nombre: "asc" }],
  });
  if (employees.length === 0) return [];

  const anioMin = Math.min(ejercicio, anioPago - 3);
  const anioMax = Math.max(ejercicio, anioPago - 1);
  const items = await prisma.payrollItem.findMany({
    where: {
      employeeId: { in: employees.map((e) => e.id) },
      payrollRun: {
        companyId,
        fechaPago: {
          gte: new Date(Date.UTC(anioMin, 0, 1)),
          lt: new Date(Date.UTC(anioMax + 1, 0, 1)),
        },
      },
    },
    select: {
      employeeId: true,
      sueldoBase: true,
      ptu: true,
      payrollRun: { select: { fechaPago: true } },
    },
  });

  const sueldoPorEmpleado = new Map<string, { suma: number; recibos: number }>();
  const ptuPorEmpleadoAnio = new Map<string, Map<number, number>>();
  for (const it of items) {
    const anio = it.payrollRun.fechaPago.getUTCFullYear();
    if (anio === ejercicio) {
      const acc = sueldoPorEmpleado.get(it.employeeId) ?? { suma: 0, recibos: 0 };
      acc.suma += it.sueldoBase;
      acc.recibos += 1;
      sueldoPorEmpleado.set(it.employeeId, acc);
    }
    if (it.ptu > 0 && anio >= anioPago - 3 && anio <= anioPago - 1) {
      const porAnio = ptuPorEmpleadoAnio.get(it.employeeId) ?? new Map<number, number>();
      porAnio.set(anio, (porAnio.get(anio) ?? 0) + it.ptu);
      ptuPorEmpleadoAnio.set(it.employeeId, porAnio);
    }
  }

  return employees.map((employee) => {
    const dias = diasTrabajadosEnEjercicio(employee.fechaIngreso, employee.fechaBaja, ejercicio);
    const sueldo = sueldoPorEmpleado.get(employee.id);
    const conRecibos = (sueldo?.recibos ?? 0) > 0;
    const salarioDevengado = conRecibos ? r2(sueldo!.suma) : r2(employee.salarioDiario * dias);

    const ptuAnios = ptuPorEmpleadoAnio.get(employee.id);
    let promedioPtu3Anios: number | null = null;
    if (ptuAnios && ptuAnios.size > 0) {
      let suma = 0;
      for (const monto of ptuAnios.values()) suma += monto;
      promedioPtu3Anios = r2(suma / ptuAnios.size);
    }

    return {
      employee,
      diasTrabajados: dias,
      salarioDevengado,
      fuenteSalario: conRecibos ? ("RECIBOS" as const) : ("ESTIMADO" as const),
      promedioPtu3Anios,
    };
  });
}

function repartoDesdeRoster(
  roster: DatosPtuEmpleado[],
  montoTotal: number,
  umaDiaria: number
) {
  const empleados: RepartoPtuEmpleado[] = roster.map((d) => ({
    employeeId: d.employee.id,
    nombre: `${d.employee.nombre} ${d.employee.apellidoPaterno}`,
    diasTrabajados: d.diasTrabajados,
    salarioDiario: d.employee.salarioDiario,
    salarioDevengado: d.salarioDevengado,
    promedioPtu3Anios: d.promedioPtu3Anios,
  }));
  return repartirPtu({ montoTotal, empleados, umaDiaria });
}

export async function previewPtu(params: {
  companyId: string;
  ejercicio: number;
  montoTotal: number;
  fechaPago?: Date;
  /** Exclusiones manuales (directores/administradores generales — Art. 127 fracc. I LFT). */
  excluirIds?: string[];
}): Promise<PtuPreview> {
  const { companyId, ejercicio, montoTotal } = params;
  const fechaPago = params.fechaPago ?? fechaPagoPtuDefault(ejercicio);
  const anioPago = fechaPago.getUTCFullYear();
  const umaDiaria = umaDiariaDelEjercicio(anioPago) ?? UMA_DIARIO;
  const excluir = new Set(params.excluirIds ?? []);

  const roster = await datosPtuEmpleados(companyId, ejercicio, anioPago);
  const participantes = roster.filter((d) => !excluir.has(d.employee.id));
  const manuales = roster.filter((d) => excluir.has(d.employee.id));

  const reparto = repartoDesdeRoster(participantes, montoTotal, umaDiaria);
  const datosPorId = new Map(roster.map((d) => [d.employee.id, d]));

  let tarifasVerificadas = true;
  const rows: PtuPreviewRow[] = reparto.asignaciones.map((a) => {
    const d = datosPorId.get(a.employeeId)!;
    const calc = calcularNomina({
      employee: d.employee as Employee & { tipoDescuentoInfonavit?: string | null },
      diasPagados: 0,
      tipo: "PTU",
      ejercicio: anioPago,
      mes: fechaPago.getUTCMonth() + 1,
      ptuMonto: a.montoTotal,
      ptuExento: a.montoExento,
    });
    if (!calc.isrTarifaVerificada) tarifasVerificadas = false;
    return {
      employeeId: a.employeeId,
      nombre: d.employee.nombre,
      apellidoPaterno: d.employee.apellidoPaterno,
      rfc: d.employee.rfc,
      salarioDiario: d.employee.salarioDiario,
      fechaIngreso: d.employee.fechaIngreso.toISOString().slice(0, 10),
      diasTrabajados: a.diasTrabajados,
      salarioDevengado: a.salarioDevengado,
      fuenteSalario: d.fuenteSalario,
      promedioPtu3Anios: d.promedioPtu3Anios,
      porDias: a.porDias,
      porSalario: a.porSalario,
      brutoSinTope: a.brutoSinTope,
      topeIndividual: a.topeIndividual,
      topado: a.topado,
      montoTotal: a.montoTotal,
      montoExento: a.montoExento,
      montoGravado: a.montoGravado,
      isr: calc.isrRetenido,
      neto: calc.netoAPagar,
    };
  });

  const excluidos: PtuPreviewExcluido[] = [
    ...reparto.excluidos.map((e) => {
      const d = datosPorId.get(e.employeeId)!;
      return {
        employeeId: e.employeeId,
        nombre: d.employee.nombre,
        apellidoPaterno: d.employee.apellidoPaterno,
        rfc: d.employee.rfc,
        diasTrabajados: e.diasTrabajados,
        motivo: e.motivo,
        manual: false,
      };
    }),
    ...manuales.map((d) => ({
      employeeId: d.employee.id,
      nombre: d.employee.nombre,
      apellidoPaterno: d.employee.apellidoPaterno,
      rfc: d.employee.rfc,
      diasTrabajados: d.diasTrabajados,
      motivo: "Exclusión manual (directores, administradores y gerentes generales no participan — Art. 127 fracc. I LFT)",
      manual: true,
    })),
  ];

  return {
    ejercicio,
    montoTotal: r2(montoTotal),
    fechaPago: fechaPago.toISOString().slice(0, 10),
    umaDiaria,
    topeExento: r2(PTU_EXENTO_UMA * umaDiaria),
    rows,
    excluidos,
    totalAsignado: reparto.totalAsignado,
    remanentePorTopes: reparto.remanentePorTopes,
    tarifaWarning: tarifasVerificadas
      ? null
      : "ISR calculado con tarifa/subsidio sin verificar para el ejercicio — cotejar antes de timbrar.",
  };
}

export async function crearCorridaPtu(params: {
  companyId: string;
  ejercicio: number;
  montoTotal: number;
  fechaPago?: Date;
  /** Roster incluido de la vista previa; `monto` presente = ajuste manual (no se redistribuye). */
  items: { employeeId: string; monto?: number }[];
}): Promise<PayrollRunResult> {
  const { companyId, ejercicio, montoTotal } = params;
  if (!Number.isFinite(montoTotal) || montoTotal <= 0) {
    return { ok: false, error: "El monto total de PTU a repartir debe ser mayor a cero." };
  }
  if (!params.items?.length) {
    return { ok: false, error: "No hay empleados incluidos en el reparto." };
  }
  const fechaPago = params.fechaPago ?? fechaPagoPtuDefault(ejercicio);
  const anioPago = fechaPago.getUTCFullYear();
  const umaDiaria = umaDiariaDelEjercicio(anioPago) ?? UMA_DIARIO;

  // El reparto SIEMPRE se recalcula en el servidor sobre el roster incluido —
  // nunca se confía en montos calculados por el cliente. Los ajustes manuales
  // sustituyen el monto de ese empleado (la exención se recalcula), sin
  // redistribuir entre los demás.
  const roster = await datosPtuEmpleados(
    companyId,
    ejercicio,
    anioPago,
    params.items.map((i) => i.employeeId)
  );
  const reparto = repartoDesdeRoster(roster, montoTotal, umaDiaria);
  if (reparto.asignaciones.length === 0) {
    return { ok: false, error: "Ningún empleado incluido es elegible para el reparto (Art. 127 fracc. VII LFT)." };
  }

  const overrides = new Map(
    params.items.filter((i) => i.monto != null).map((i) => [i.employeeId, i.monto!])
  );
  for (const monto of overrides.values()) {
    if (!Number.isFinite(monto) || monto < 0) {
      return { ok: false, error: "Los montos ajustados de PTU deben ser números no negativos." };
    }
  }

  const ptuAsignaciones: Record<string, { monto: number; exento: number }> = {};
  for (const a of reparto.asignaciones) {
    const monto = overrides.has(a.employeeId) ? r2(overrides.get(a.employeeId)!) : a.montoTotal;
    ptuAsignaciones[a.employeeId] = {
      monto,
      exento: r2(Math.min(monto, PTU_EXENTO_UMA * umaDiaria)),
    };
  }

  return createPayrollRun({
    companyId,
    tipo: "PTU",
    periodoInicio: new Date(Date.UTC(ejercicio, 0, 1)),
    periodoFin: new Date(Date.UTC(ejercicio, 11, 31)),
    fechaPago,
    // La PTU está excluida del salario base de cotización (Art. 27 fracc. IV
    // LSS) — 0 días de cotización IMSS en esta corrida.
    diasPagados: 0,
    employeeIds: Object.keys(ptuAsignaciones),
    ptuAsignaciones,
    ptuMontoTotal: r2(montoTotal),
    ejercicio,
  });
}
