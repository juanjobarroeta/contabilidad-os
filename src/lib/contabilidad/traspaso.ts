// ─────────────────────────────────────────────────────────────────────────────
// Traspaso del resultado del ejercicio (305.01 → 304.01) — Fase 3.2.
//
// `generarCierre` (mes 13) cancela ingresos/costos/gastos contra «Utilidad del
// ejercicio» (305.01), que es exactamente lo que el SAT espera ver en la
// balanza de mes 13. Pero ese saldo NO puede quedarse ahí: al arrancar el
// ejercicio siguiente, 305.01 debe volver a cero para acumular el resultado del
// año nuevo, y el resultado del año que terminó pasa a «Utilidad de ejercicios
// anteriores» (304.01). Sin este asiento, el capital contable duplica
// resultados año con año y el balance general deja de ser legible.
//
// Decisiones:
//   - El asiento vive en el mes 1 del ejercicio SIGUIENTE (fecha 1-ene), que es
//     donde ocurre la aplicación del resultado. El mes 13 conserva intacta la
//     foto que se le entregó al SAT.
//   - Fuente CIERRE (no APERTURA): postMonth preserva ambas, pero postApertura
//     borra TODOS los asientos APERTURA de la empresa al recapturar saldos
//     iniciales, y eso se llevaría el traspaso por delante.
//   - Idempotente por `referencia` ("traspaso-<ejercicio>"): regenerarlo
//     reemplaza el anterior en vez de duplicarlo.
//
// `construirTraspaso` es PURO y testeable; `generarTraspasoResultado` lee el
// saldo real y persiste.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { COE_CODES } from "./catalog";
import { resolveAccount } from "./seed-catalog";
import { assertPeriodoAbierto } from "./candado";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface TraspasoAsiento {
  entries: { chartAccountId: string; tipo: "CARGO" | "ABONO"; monto: number }[];
  /** Utilidad (+) o pérdida (−) traspasada. */
  resultado: number;
}

/**
 * Construye el traspaso a partir del saldo ACREEDOR de 305.01 (signo natural de
 * una cuenta de capital: utilidad positiva, pérdida negativa).
 *
 * Utilidad → CARGO a 305.01 (la vacía) y ABONO a 304.01 (la acumula).
 * Pérdida  → el asiento inverso.
 * Un saldo ~0 no genera asiento: no hay nada que traspasar.
 */
export function construirTraspaso(
  saldoResultado: number,
  resultadoEjercicioId: string,
  resultadosAcumuladosId: string
): TraspasoAsiento {
  const resultado = r2(saldoResultado);
  if (Math.abs(resultado) < 0.005) return { entries: [], resultado: 0 };

  const monto = r2(Math.abs(resultado));
  const utilidad = resultado > 0;
  return {
    resultado,
    entries: [
      { chartAccountId: resultadoEjercicioId, tipo: utilidad ? "CARGO" : "ABONO", monto },
      { chartAccountId: resultadosAcumuladosId, tipo: utilidad ? "ABONO" : "CARGO", monto },
    ],
  };
}

export class TraspasoError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "TraspasoError";
  }
}

/** Referencia estable del asiento, para que regenerarlo sea idempotente. */
export function referenciaTraspaso(ejercicio: number): string {
  return `traspaso-${ejercicio}`;
}

/**
 * Traspasa el resultado del ejercicio `year` al mes 1 de `year + 1`.
 *
 * El saldo que se mueve es el ACUMULADO de 305.01 hasta el cierre de `year`
 * (todos los asientos con year ≤ `year`), que ya incluye el traspaso del año
 * anterior — por eso el neto es exactamente el resultado de este ejercicio.
 */
export async function generarTraspasoResultado(
  companyId: string,
  year: number
): Promise<{ entries: number; resultado: number; ejercicioDestino: number }> {
  const [resultadoAcc, acumuladosAcc] = await Promise.all([
    resolveAccount(companyId, COE_CODES.RESULTADO_EJERCICIO).catch(() => null),
    resolveAccount(companyId, COE_CODES.RESULTADOS_ACUMULADOS).catch(() => null),
  ]);
  if (!resultadoAcc) {
    throw new TraspasoError(`Falta la cuenta de Resultado del ejercicio (${COE_CODES.RESULTADO_EJERCICIO})`);
  }
  if (!acumuladosAcc) {
    throw new TraspasoError(`Falta la cuenta de Resultados acumulados (${COE_CODES.RESULTADOS_ACUMULADOS})`);
  }

  // Sin asiento de cierre no hay resultado que traspasar: el saldo de 305.01
  // seguiría siendo el del año pasado y moverlo dejaría el capital mal.
  const cierre = await prisma.accountingEntry.count({
    where: { companyId, year, month: 13, fuente: "CIERRE" },
  });
  if (cierre === 0) {
    throw new TraspasoError(
      `El ejercicio ${year} todavía no tiene asiento de cierre (mes 13). Genéralo primero con el botón «Cierre ${year}».`
    );
  }

  // Saldo acumulado de 305.01 hasta el cierre de este ejercicio.
  const groups = await prisma.accountingEntry.groupBy({
    by: ["tipo"],
    where: { companyId, chartAccountId: resultadoAcc.id, year: { lte: year } },
    _sum: { monto: true },
  });
  let cargos = 0;
  let abonos = 0;
  for (const g of groups) {
    if (g.tipo === "CARGO") cargos += g._sum.monto ?? 0;
    else abonos += g._sum.monto ?? 0;
  }
  // 305.01 es de capital (acreedora): saldo natural = abonos − cargos.
  const asiento = construirTraspaso(abonos - cargos, resultadoAcc.id, acumuladosAcc.id);

  const destino = year + 1;
  const fecha = new Date(Date.UTC(destino, 0, 1, 12));
  const referencia = referenciaTraspaso(year);

  await prisma.$transaction(async (tx) => {
    await assertPeriodoAbierto(tx, companyId, destino, 1);
    const period = await tx.accountingPeriod.upsert({
      where: { companyId_year_month: { companyId, year: destino, month: 1 } },
      update: {},
      create: { companyId, year: destino, month: 1, status: "DRAFT" },
    });
    // Idempotencia: un traspaso por ejercicio.
    await tx.accountingEntry.deleteMany({ where: { companyId, referencia, referenciaTipo: "TRASPASO" } });
    if (asiento.entries.length > 0) {
      await tx.accountingEntry.createMany({
        data: asiento.entries.map((e) => ({
          companyId,
          chartAccountId: e.chartAccountId,
          year: destino,
          month: 1,
          periodId: period.id,
          fecha,
          descripcion: `Traspaso del resultado del ejercicio ${year}`,
          referencia,
          referenciaTipo: "TRASPASO",
          monto: e.monto,
          tipo: e.tipo,
          fuente: "CIERRE" as const,
        })),
      });
    }
  });

  return { entries: asiento.entries.length, resultado: asiento.resultado, ejercicioDestino: destino };
}
