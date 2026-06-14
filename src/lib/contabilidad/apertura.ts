// ─────────────────────────────────────────────────────────────────────────────
// Asiento de apertura / saldos iniciales (COE M2).
//
// Una empresa que migra a media vida captura sus saldos por cuenta a una fecha;
// los guardamos como AccountingEntry con fuente=APERTURA, de modo que balanza()
// los toma como SaldoInicial de los periodos siguientes (vía Σ movimientos
// previos). Re-postear un mes NO los borra (posting.ts conserva fuente APERTURA).
//
// `construirApertura` es PURO y testeable; `postApertura` resuelve cuentas y
// persiste. El asiento DEBE cuadrar (Σ cargos = Σ abonos), como cualquier balance.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { naturalezaPorTipo, type Naturaleza } from "./coe-saldos";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface AperturaLineaPura {
  chartAccountId: string;
  naturaleza: Naturaleza;
  /** Saldo en signo NATURAL de la cuenta (deudora +cargo, acreedora +abono). */
  saldo: number;
}

export interface AperturaAsiento {
  entries: { chartAccountId: string; tipo: "CARGO" | "ABONO"; monto: number }[];
  totalCargos: number;
  totalAbonos: number;
  diferencia: number;
  balanceado: boolean;
}

/**
 * Convierte saldos por cuenta (signo natural) en partidas CARGO/ABONO y verifica
 * la partida doble. deudora con saldo + → CARGO; acreedora con saldo + → ABONO;
 * un saldo negativo invierte. Omite saldos ~0.
 */
export function construirApertura(lineas: AperturaLineaPura[]): AperturaAsiento {
  const entries: AperturaAsiento["entries"] = [];
  let totalCargos = 0;
  let totalAbonos = 0;
  for (const l of lineas) {
    if (Math.abs(l.saldo) < 0.005) continue;
    const monto = r2(Math.abs(l.saldo));
    // Naturaleza deudora + saldo positivo → CARGO; XOR invierte.
    const esCargo = (l.naturaleza === "D") === (l.saldo >= 0);
    entries.push({ chartAccountId: l.chartAccountId, tipo: esCargo ? "CARGO" : "ABONO", monto });
    if (esCargo) totalCargos += monto;
    else totalAbonos += monto;
  }
  totalCargos = r2(totalCargos);
  totalAbonos = r2(totalAbonos);
  const diferencia = r2(totalCargos - totalAbonos);
  return { entries, totalCargos, totalAbonos, diferencia, balanceado: Math.abs(diferencia) < 0.01 };
}

export class AperturaError extends Error {
  constructor(message: string, readonly diferencia?: number) {
    super(message);
    this.name = "AperturaError";
  }
}

/**
 * Persiste el asiento de apertura a una fecha. Reemplaza cualquier apertura previa
 * de la empresa (idempotente). Lanza AperturaError si no cuadra o falta una cuenta.
 */
export async function postApertura(
  companyId: string,
  fechaISO: string,
  lineas: { codigo: string; saldo: number }[],
): Promise<{ entries: number; totalCargos: number; totalAbonos: number; fecha: string }> {
  const fecha = new Date(fechaISO);
  if (isNaN(fecha.getTime())) throw new AperturaError("Fecha inválida");
  const year = fecha.getFullYear();
  const month = fecha.getMonth() + 1;

  const accounts = await prisma.chartAccount.findMany({
    where: { companyId, isActive: true },
    select: { id: true, cuentaSAT: true, subcuenta: true, tipo: true, naturaleza: true },
  });
  const byCode = new Map(accounts.map((a) => [a.subcuenta ?? a.cuentaSAT, a]));

  const puras: AperturaLineaPura[] = lineas.map((l) => {
    const acc = byCode.get(l.codigo);
    if (!acc) throw new AperturaError(`Cuenta no encontrada en el catálogo: ${l.codigo}`);
    return {
      chartAccountId: acc.id,
      naturaleza: ((acc.naturaleza as Naturaleza | null) ?? naturalezaPorTipo(acc.tipo)),
      saldo: l.saldo,
    };
  });

  const asiento = construirApertura(puras);
  if (!asiento.balanceado) {
    throw new AperturaError(
      `El asiento de apertura no cuadra: cargos ${asiento.totalCargos} vs abonos ${asiento.totalAbonos} (diferencia ${asiento.diferencia}). Incluye capital/resultados acumulados para cuadrar.`,
      asiento.diferencia,
    );
  }

  await prisma.$transaction(async (tx) => {
    const period = await tx.accountingPeriod.upsert({
      where: { companyId_year_month: { companyId, year, month } },
      update: {},
      create: { companyId, year, month, status: "DRAFT" },
    });
    // Una sola apertura por empresa: reemplaza la anterior si la hubiera.
    await tx.accountingEntry.deleteMany({ where: { companyId, fuente: "APERTURA" } });
    if (asiento.entries.length > 0) {
      await tx.accountingEntry.createMany({
        data: asiento.entries.map((e) => ({
          companyId,
          chartAccountId: e.chartAccountId,
          year,
          month,
          periodId: period.id,
          fecha,
          descripcion: "Saldo inicial (asiento de apertura)",
          monto: e.monto,
          tipo: e.tipo,
          fuente: "APERTURA" as const,
        })),
      });
    }
  });

  return {
    entries: asiento.entries.length,
    totalCargos: asiento.totalCargos,
    totalAbonos: asiento.totalAbonos,
    fecha: fecha.toISOString().slice(0, 10),
  };
}
