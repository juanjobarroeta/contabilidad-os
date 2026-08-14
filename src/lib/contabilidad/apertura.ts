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
import { PeriodoCerradoError } from "./ejercicio";

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
export function construirApertura(
  lineas: AperturaLineaPura[],
  /**
   * Tolerancia en pesos para dar el asiento por cuadrado. Por defecto un
   * centavo, que es lo correcto para una apertura capturada a mano.
   *
   * Una balanza del SAT es otra cosa: trae cada cuenta redondeada a dos
   * decimales, así que el residuo crece con el número de cuentas y no con
   * ningún error. Con 438 hojas, MARGOM cierra a $0.13 — el propio documento
   * del SAT no cuadra al centavo. Ver `toleranciaPorRedondeo`.
   */
  tolerancia = 0.01,
): AperturaAsiento {
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
  return {
    entries,
    totalCargos,
    totalAbonos,
    diferencia,
    balanceado: Math.abs(diferencia) <= tolerancia,
  };
}

/**
 * Cota EXACTA del residuo que puede meter el redondeo del documento: cada
 * importe viene redondeado a dos decimales, así que cada uno aporta como mucho
 * medio centavo. No es un margen elegido a ojo ni un número que crezca hasta
 * tapar un error real — con 438 cuentas da $2.19, y un descuadre de verdad
 * (los $48,318,111.11 de MARGOM leyendo mal el signo) lo rebasa por siete
 * órdenes de magnitud.
 */
export function toleranciaPorRedondeo(cuentas: number): number {
  return r2(Math.max(1, cuentas) * 0.005);
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

  // Candado de ejercicio: recapturar la apertura BORRA todos los asientos
  // APERTURA de la empresa (es una sola por empresa, ver abajo), así que
  // reescribiría el arranque de un ejercicio ya cerrado. Basta con que exista
  // UN periodo cerrado para negarse — hay que reabrirlo primero.
  const cerrado = await prisma.accountingPeriod.findFirst({
    where: { companyId, status: "CLOSED" },
    select: { year: true, month: true },
    orderBy: [{ year: "asc" }, { month: "asc" }],
  });
  if (cerrado) throw new PeriodoCerradoError(cerrado.year, cerrado.month);

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

  // Una balanza del SAT trae cada cuenta redondeada a dos decimales, así que el
  // residuo crece con el número de cuentas y no con ningún error: MARGOM cierra
  // a $0.13 sobre 438 hojas y $1,191,644,288 por lado. El propio documento del
  // SAT no cuadra al centavo. La cota es exacta (medio centavo por cuenta), así
  // que no puede tapar un descuadre real.
  const asiento = construirApertura(puras, toleranciaPorRedondeo(puras.length));
  if (!asiento.balanceado) {
    throw new AperturaError(
      `El asiento de apertura no cuadra: cargos ${asiento.totalCargos} vs abonos ${asiento.totalAbonos} (diferencia ${asiento.diferencia}). Incluye capital/resultados acumulados para cuadrar.`,
      asiento.diferencia,
    );
  }

  // Cuadrar «dentro de tolerancia» no es cuadrar: si el residuo se deja fuera,
  // el libro arranca torcido por esos centavos para siempre. Se postea como una
  // línea PROPIA y con nombre, para que quien audite vea de dónde salió en vez
  // de encontrarlo escondido dentro del saldo de otra cuenta.
  let ajuste: { chartAccountId: string; tipo: "CARGO" | "ABONO"; monto: number } | null = null;
  if (Math.abs(asiento.diferencia) >= 0.005) {
    const cuenta = await cuentaDeAjustePorRedondeo(companyId);
    ajuste = {
      chartAccountId: cuenta,
      // Sobran cargos → el ajuste es abono, y al revés.
      tipo: asiento.diferencia > 0 ? "ABONO" : "CARGO",
      monto: r2(Math.abs(asiento.diferencia)),
    };
    asiento.entries.push(ajuste);
    if (ajuste.tipo === "ABONO") asiento.totalAbonos = r2(asiento.totalAbonos + ajuste.monto);
    else asiento.totalCargos = r2(asiento.totalCargos + ajuste.monto);
    asiento.diferencia = r2(asiento.totalCargos - asiento.totalAbonos);
    console.log(
      `[apertura] ${companyId}: residuo de redondeo ${ajuste.tipo} ${ajuste.monto} ` +
        `sobre ${puras.length} cuentas (cota ${toleranciaPorRedondeo(puras.length)}).`,
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

/**
 * Cuenta donde aterriza el residuo de redondeo de la apertura. Se crea una sola
 * vez por empresa y se reutiliza; el código no choca con ningún agrupador del
 * SAT a propósito, porque no es una cuenta del catálogo oficial sino nuestra.
 *
 * Naturaleza deudora por convención: el signo real lo lleva el tipo del
 * movimiento (CARGO/ABONO), no la cuenta.
 */
async function cuentaDeAjustePorRedondeo(companyId: string): Promise<string> {
  const CODIGO = "AJUSTE-REDONDEO";
  const ya = await prisma.chartAccount.findFirst({
    where: { companyId, cuentaSAT: CODIGO, subcuenta: null },
    select: { id: true },
  });
  if (ya) return ya.id;
  const creada = await prisma.chartAccount.create({
    data: {
      companyId,
      cuentaSAT: CODIGO,
      subcuenta: null,
      nombre: "Ajuste por redondeo de la balanza",
      tipo: "CAPITAL",
      nivel: 1,
      naturaleza: "D",
    },
    select: { id: true },
  });
  return creada.id;
}
