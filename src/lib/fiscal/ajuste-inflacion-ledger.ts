// ─────────────────────────────────────────────────────────────────────────────
// Lectura del ledger para el ajuste anual por inflación.
//
// Vive aparte del motor (`ajuste-inflacion.ts`, puro) porque toca Prisma. La
// usan el panel de la anual y el auditor 24/7, así que la consulta vive UNA vez.
//
// Arma el saldo AL ÚLTIMO DÍA de cada mes con dos agregados —saldo previo al
// ejercicio + movimientos del año por mes— en vez de doce llamadas a
// `balanza()`.
// ─────────────────────────────────────────────────────────────────────────────

import { naturalezaPorTipo, type Naturaleza } from "@/lib/contabilidad/coe-saldos";
import { prisma } from "@/lib/prisma";
import {
  calcularAjusteInflacion,
  type ClaseAjuste,
  type CuentaSaldos,
  type ResultadoAjuste,
} from "./ajuste-inflacion";

/** El mes 13 es el cierre: sus asientos no forman parte del saldo de diciembre. */
export const MESES_EJERCICIO = 12;

export interface DatosAjusteLedger {
  resultado: ResultadoAjuste;
  mesesSinPostear: number[];
}

export async function cargarAjusteInflacion(
  companyId: string,
  ejercicio: number,
  overrides: Record<string, ClaseAjuste> = {}
): Promise<DatosAjusteLedger> {
  const [cuentas, previos, delAnio, periodos] = await Promise.all([
    prisma.chartAccount.findMany({
      where: { companyId, isActive: true, tipo: { in: ["ACTIVO", "PASIVO", "CAPITAL"] } },
      select: { id: true, cuentaSAT: true, subcuenta: true, nombre: true, tipo: true, naturaleza: true },
      orderBy: [{ cuentaSAT: "asc" }, { subcuenta: "asc" }],
    }),
    // Saldo acumulado ANTES del ejercicio: el arranque de enero.
    prisma.accountingEntry.groupBy({
      by: ["chartAccountId", "tipo"],
      where: { companyId, year: { lt: ejercicio } },
      _sum: { monto: true },
    }),
    prisma.accountingEntry.groupBy({
      by: ["chartAccountId", "month", "tipo"],
      where: { companyId, year: ejercicio, month: { lte: MESES_EJERCICIO } },
      _sum: { monto: true },
    }),
    prisma.accountingPeriod.findMany({
      where: { companyId, year: ejercicio, month: { lte: MESES_EJERCICIO } },
      select: { month: true, status: true },
    }),
  ]);

  const natPorCuenta = new Map<string, Naturaleza>(
    cuentas.map((c) => [c.id, (c.naturaleza as Naturaleza | null) ?? naturalezaPorTipo(c.tipo)])
  );
  /** Movimiento con el signo NATURAL de la cuenta (positivo = saldo normal). */
  const natural = (nat: Naturaleza, tipo: string, monto: number) =>
    (nat === "D") === (tipo === "CARGO") ? monto : -monto;

  const saldoPrevio = new Map<string, number>();
  for (const g of previos) {
    const nat = natPorCuenta.get(g.chartAccountId);
    if (!nat) continue;
    const delta = natural(nat, g.tipo, g._sum.monto ?? 0);
    saldoPrevio.set(g.chartAccountId, (saldoPrevio.get(g.chartAccountId) ?? 0) + delta);
  }

  const movPorMes = new Map<string, number[]>();
  for (const g of delAnio) {
    const nat = natPorCuenta.get(g.chartAccountId);
    if (!nat || g.month < 1 || g.month > MESES_EJERCICIO) continue;
    const fila = movPorMes.get(g.chartAccountId) ?? Array<number>(MESES_EJERCICIO).fill(0);
    fila[g.month - 1] += natural(nat, g.tipo, g._sum.monto ?? 0);
    movPorMes.set(g.chartAccountId, fila);
  }

  const entrada: CuentaSaldos[] = cuentas.map((c) => {
    const mov = movPorMes.get(c.id) ?? Array<number>(MESES_EJERCICIO).fill(0);
    // Saldo AL ÚLTIMO DÍA de cada mes = acumulado, no movimiento del mes.
    let acumulado = saldoPrevio.get(c.id) ?? 0;
    const saldosMensuales: number[] = [];
    for (const m of mov) {
      acumulado += m;
      saldosMensuales.push(acumulado);
    }
    return { cuentaSAT: c.cuentaSAT, subcuenta: c.subcuenta, nombre: c.nombre, saldosMensuales };
  });

  const posteados = new Set(
    periodos.filter((p) => p.status === "POSTED" || p.status === "CLOSED").map((p) => p.month)
  );
  const mesesSinPostear = Array.from({ length: MESES_EJERCICIO }, (_, i) => i + 1).filter(
    (m) => !posteados.has(m)
  );

  return {
    resultado: calcularAjusteInflacion({ year: ejercicio, cuentas: entrada, overrides, mesesSinPostear }),
    mesesSinPostear,
  };
}
