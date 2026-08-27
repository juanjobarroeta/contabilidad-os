// ─────────────────────────────────────────────────────────────────────────────
// Depreciación del registro de activo fijo, agregada por ejercicio.
//
// Fuente única de verdad para la deducción de inversiones del ejercicio:
// la usan tanto /api/activos (la tabla) como la declaración anual (la
// deducción que se resta del ISR). Aplica acumulada de ejercicios previos
// (para topar al MOI) y el factor de actualización INPC (Art. 31).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import {
  calcularDepreciacionEjercicio,
  mesesUsoEnEjercicio,
  type TipoActivo,
  type DepreciacionResult,
} from "./depreciacion";
import { factorActualizacionDepreciacion, type FactorActualizacion } from "./inpc";

export interface ActivoConDepreciacion {
  id: string;
  descripcion: string;
  tipo: string;
  moi: number;
  fechaAdquisicion: Date;
  esAutomovil: boolean;
  esElectricoHibrido: boolean;
  fechaBaja: Date | null;
  autoCreado: boolean;
  invoice: { uuid: string | null; serie: string | null; folio: string | null } | null;
  depreciacion: DepreciacionResult & {
    depreciacionAcumuladaPrevia: number;
    actualizacion: FactorActualizacion;
  };
}

export interface RegistroDepreciacion {
  activos: ActivoConDepreciacion[];
  totalDepreciacionEjercicio: number;
}

/** Depreciación del registro para un ejercicio (con acumulada previa + INPC). */
export async function calcularDepreciacionRegistro(
  companyId: string,
  ejercicio: number
): Promise<RegistroDepreciacion> {
  const activos = await prisma.activoFijo.findMany({
    where: { companyId },
    orderBy: { fechaAdquisicion: "desc" },
    include: { invoice: { select: { uuid: true, serie: true, folio: true } } },
  }).then((rows) => rows.map((a) => ({ ...a, moi: Number(a.moi), tasaAnual: Number(a.tasaAnual) })));

  let totalDepreciacionEjercicio = 0;
  const rows = activos.map((a): ActivoConDepreciacion => {
    // Acumulada nominal de ejercicios ANTERIORES (para topar al MOI).
    const adqYear = a.fechaAdquisicion.getFullYear();
    let acumPrevia = 0;
    for (let y = adqYear; y < ejercicio; y++) {
      const prev = calcularDepreciacionEjercicio({
        moi: a.moi, fechaAdquisicion: a.fechaAdquisicion, tipo: a.tipo as TipoActivo,
        ejercicio: y, esAutomovil: a.esAutomovil, esElectricoHibrido: a.esElectricoHibrido,
        fechaBaja: a.fechaBaja, depreciacionAcumuladaPrevia: acumPrevia,
      });
      acumPrevia += prev.depreciacionNominalEjercicio;
    }

    const meses = mesesUsoEnEjercicio(a.fechaAdquisicion, ejercicio, a.fechaBaja);
    const startMonthIndex = adqYear < ejercicio ? 0 : a.fechaAdquisicion.getMonth();
    const fa = factorActualizacionDepreciacion({
      fechaAdquisicion: a.fechaAdquisicion, ejercicio, startMonthIndex, mesesUso: meses,
    });
    const dep = calcularDepreciacionEjercicio({
      moi: a.moi, fechaAdquisicion: a.fechaAdquisicion, tipo: a.tipo as TipoActivo,
      ejercicio, esAutomovil: a.esAutomovil, esElectricoHibrido: a.esElectricoHibrido,
      fechaBaja: a.fechaBaja, depreciacionAcumuladaPrevia: acumPrevia, factorInpc: fa.factor,
    });
    totalDepreciacionEjercicio += dep.depreciacionEjercicio;

    return {
      id: a.id, descripcion: a.descripcion, tipo: a.tipo, moi: a.moi,
      fechaAdquisicion: a.fechaAdquisicion, esAutomovil: a.esAutomovil,
      esElectricoHibrido: a.esElectricoHibrido, fechaBaja: a.fechaBaja, autoCreado: a.autoCreado, invoice: a.invoice,
      depreciacion: { ...dep, depreciacionAcumuladaPrevia: Math.round(acumPrevia * 100) / 100, actualizacion: fa },
    };
  });

  return { activos: rows, totalDepreciacionEjercicio: Math.round(totalDepreciacionEjercicio * 100) / 100 };
}

/**
 * Depreciación acumulada del ejercicio ENE→hastaMes (1-12) — para el pago
 * provisional de PF act. empresarial (Art. 106), que deduce la parte
 * proporcional de la deducción de inversiones del periodo. Devuelve sólo el
 * total (nominal × factor INPC del periodo, cae a nominal donde falte índice).
 */
export async function calcularDepreciacionRegistroPeriodo(
  companyId: string,
  ejercicio: number,
  hastaMes: number
): Promise<number> {
  const activos = await prisma.activoFijo.findMany({ where: { companyId } }).then((rows) => rows.map((a) => ({ ...a, moi: Number(a.moi), tasaAnual: Number(a.tasaAnual) })));
  let total = 0;
  for (const a of activos) {
    const adqYear = a.fechaAdquisicion.getFullYear();
    let acumPrevia = 0;
    for (let y = adqYear; y < ejercicio; y++) {
      const prev = calcularDepreciacionEjercicio({
        moi: a.moi, fechaAdquisicion: a.fechaAdquisicion, tipo: a.tipo as TipoActivo,
        ejercicio: y, esAutomovil: a.esAutomovil, esElectricoHibrido: a.esElectricoHibrido,
        fechaBaja: a.fechaBaja, depreciacionAcumuladaPrevia: acumPrevia,
      });
      acumPrevia += prev.depreciacionNominalEjercicio;
    }
    const meses = mesesUsoEnEjercicio(a.fechaAdquisicion, ejercicio, a.fechaBaja, hastaMes);
    const startMonthIndex = adqYear < ejercicio ? 0 : a.fechaAdquisicion.getMonth();
    const fa = factorActualizacionDepreciacion({ fechaAdquisicion: a.fechaAdquisicion, ejercicio, startMonthIndex, mesesUso: meses });
    const dep = calcularDepreciacionEjercicio({
      moi: a.moi, fechaAdquisicion: a.fechaAdquisicion, tipo: a.tipo as TipoActivo,
      ejercicio, esAutomovil: a.esAutomovil, esElectricoHibrido: a.esElectricoHibrido,
      fechaBaja: a.fechaBaja, depreciacionAcumuladaPrevia: acumPrevia, factorInpc: fa.factor, hastaMes,
    });
    total += dep.depreciacionEjercicio;
  }
  return Math.round(total * 100) / 100;
}
