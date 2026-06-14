// ─────────────────────────────────────────────────────────────────────────────
// Cierre anual / asiento de mes 13 (COE M3).
//
// Al cierre del ejercicio, las cuentas de resultados (INGRESO/COSTO/GASTO) se
// cancelan contra "Resultado del ejercicio" (capital). El asiento vive en el
// periodo mes=13, de modo que la Balanza de mes 13 (que el SAT pide para PM)
// muestre ingresos/gastos en cero y el resultado reflejado en capital.
//
// `construirCierre` es PURO y testeable; `generarCierre` lee saldos y persiste.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { COE_CODES } from "./catalog";
import { resolveAccount } from "./seed-catalog";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface CierreCuenta {
  chartAccountId: string;
  /** INGRESO (acreedora) | COSTO | GASTO (deudoras). */
  tipo: "INGRESO" | "COSTO" | "GASTO";
  /** Saldo del ejercicio en signo natural (ingreso +abono, costo/gasto +cargo). */
  saldo: number;
}

export interface CierreAsiento {
  entries: { chartAccountId: string; tipo: "CARGO" | "ABONO"; monto: number }[];
  totalIngresos: number;
  totalGastos: number;
  /** Utilidad (+) o pérdida (−) del ejercicio. */
  resultado: number;
}

/**
 * Construye el asiento de cierre: cancela cada cuenta de resultados con el
 * asiento opuesto a su saldo y lleva el neto a `resultadoEjercicioId` (capital,
 * acreedora). Cuadra por construcción (el resultado es la partida de ajuste).
 */
export function construirCierre(cuentas: CierreCuenta[], resultadoEjercicioId: string): CierreAsiento {
  const entries: CierreAsiento["entries"] = [];
  let totalIngresos = 0;
  let totalGastos = 0;

  for (const c of cuentas) {
    if (Math.abs(c.saldo) < 0.005) continue;
    const esIngreso = c.tipo === "INGRESO"; // acreedora
    if (esIngreso) totalIngresos += c.saldo;
    else totalGastos += c.saldo;
    // Cerrar = asiento opuesto al saldo. Ingreso (acreedor +) → CARGO; gasto
    // (deudor +) → ABONO. Un saldo negativo invierte el lado.
    const cierraConCargo = esIngreso ? c.saldo >= 0 : c.saldo < 0;
    entries.push({ chartAccountId: c.chartAccountId, tipo: cierraConCargo ? "CARGO" : "ABONO", monto: r2(Math.abs(c.saldo)) });
  }

  totalIngresos = r2(totalIngresos);
  totalGastos = r2(totalGastos);
  const resultado = r2(totalIngresos - totalGastos);

  // Contrapartida en Resultado del ejercicio (capital, acreedora): utilidad → ABONO.
  if (Math.abs(resultado) >= 0.005) {
    entries.push({
      chartAccountId: resultadoEjercicioId,
      tipo: resultado >= 0 ? "ABONO" : "CARGO",
      monto: r2(Math.abs(resultado)),
    });
  }

  return { entries, totalIngresos, totalGastos, resultado };
}

export class CierreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CierreError";
  }
}

/** Genera (o regenera) el asiento de cierre del ejercicio `year` en el mes 13. */
export async function generarCierre(
  companyId: string,
  year: number,
): Promise<{ entries: number; resultado: number; totalIngresos: number; totalGastos: number }> {
  const cuentasResultado = await prisma.chartAccount.findMany({
    where: { companyId, isActive: true, tipo: { in: ["INGRESO", "COSTO", "GASTO"] } },
    select: { id: true, tipo: true },
  });
  if (cuentasResultado.length === 0) throw new CierreError("Sin cuentas de resultados en el catálogo");

  const ids = cuentasResultado.map((c) => c.id);
  const tipoPorId = new Map(cuentasResultado.map((c) => [c.id, c.tipo as "INGRESO" | "COSTO" | "GASTO"]));

  // Movimiento del ejercicio (todos los meses del año) por cuenta de resultados.
  const groups = await prisma.accountingEntry.groupBy({
    by: ["chartAccountId", "tipo"],
    where: { companyId, year, chartAccountId: { in: ids } },
    _sum: { monto: true },
  });
  const mov = new Map<string, { cargo: number; abono: number }>();
  for (const g of groups) {
    const m = mov.get(g.chartAccountId) ?? { cargo: 0, abono: 0 };
    if (g.tipo === "CARGO") m.cargo += g._sum.monto ?? 0;
    else m.abono += g._sum.monto ?? 0;
    mov.set(g.chartAccountId, m);
  }

  const cuentas: CierreCuenta[] = [];
  for (const [chartAccountId, m] of mov) {
    const tipo = tipoPorId.get(chartAccountId)!;
    // saldo natural: ingreso (acreedora) = abono−cargo; costo/gasto (deudora) = cargo−abono
    const saldo = tipo === "INGRESO" ? m.abono - m.cargo : m.cargo - m.abono;
    cuentas.push({ chartAccountId, tipo, saldo });
  }

  const resultadoAcc = await resolveAccount(companyId, COE_CODES.RESULTADO_EJERCICIO).catch(() => null);
  if (!resultadoAcc) throw new CierreError(`Falta la cuenta de Resultado del ejercicio (${COE_CODES.RESULTADO_EJERCICIO})`);

  const asiento = construirCierre(cuentas, resultadoAcc.id);

  const fecha = new Date(year, 11, 31); // 31-dic del ejercicio
  await prisma.$transaction(async (tx) => {
    const period = await tx.accountingPeriod.upsert({
      where: { companyId_year_month: { companyId, year, month: 13 } },
      update: {},
      create: { companyId, year, month: 13, status: "DRAFT" },
    });
    await tx.accountingEntry.deleteMany({ where: { companyId, year, month: 13, fuente: "CIERRE" } });
    if (asiento.entries.length > 0) {
      await tx.accountingEntry.createMany({
        data: asiento.entries.map((e) => ({
          companyId,
          chartAccountId: e.chartAccountId,
          year,
          month: 13,
          periodId: period.id,
          fecha,
          descripcion: "Asiento de cierre del ejercicio",
          monto: e.monto,
          tipo: e.tipo,
          fuente: "CIERRE" as const,
        })),
      });
    }
  });

  return {
    entries: asiento.entries.length,
    resultado: asiento.resultado,
    totalIngresos: asiento.totalIngresos,
    totalGastos: asiento.totalGastos,
  };
}
