// ─────────────────────────────────────────────────────────────────────────────
// Sugerencias de categoría para movimientos bancarios SIN CFDI + aprobación
//
// Mantiene los libros completos para los movimientos que NO empatan con un CFDI
// (comisiones, impuestos, nómina, traspasos, intereses, renta, …):
//
//   1. `sugerenciasPeriodo()` — para una empresa + periodo, lista los
//      movimientos UNMATCHED sin CFDI y, por cada uno, la sugerencia del motor de
//      reglas (con fallback LLM opcional). NO escribe en el ledger.
//
//   2. `aprobarSugerencia()` — el usuario aprueba: se escribe el asiento de
//      partida doble (fuente BANCO) para ese movimiento con la cuenta elegida, de
//      forma IDEMPOTENTE, y el movimiento se marca IGNORED con la etiqueta de
//      familia en `notes` (la misma que lee el cierre mensual postMonth), para que
//      el cierre regenere exactamente el mismo asiento en vez de bloquear el mes.
//      Aprobar es lo ÚNICO que escribe en el ledger.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import type { EntryType, EntrySource } from "@prisma/client";
import { COE_CODES } from "@/lib/contabilidad/catalog";
import { resolveAccount } from "@/lib/contabilidad/seed-catalog";
import {
  sugerirCategoriaConcepto,
  signoDeMonto,
  type FamiliaConcepto,
  type SugerenciaCategoria,
} from "./categorizar-concepto";
import { sugerirCategoriaConceptoLLM } from "./categorizar-llm";

export interface MovimientoConSugerencia {
  transaction: {
    id: string;
    fecha: Date;
    descripcion: string;
    monto: number;
    bankAccountId: string;
  };
  sugerencia: (SugerenciaCategoria & { fuenteSugerencia: "reglas" | "llm" }) | null;
  /** Deep link para abrir/aprobar la sugerencia en la app. */
  deepLink: string;
}

const monthRange = (year: number, month: number) => {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
};

/**
 * Lista los movimientos bancarios UNMATCHED SIN CFDI de un periodo junto con la
 * categoría sugerida. NO escribe nada en el ledger.
 *
 * @param usarLLM  Si true, intenta el fallback LLM para los conceptos que el
 *                 motor de reglas no clasifica (acotado y medido en CostEvent).
 */
export async function sugerenciasPeriodo(
  companyId: string,
  year: number,
  month: number,
  opts: { usarLLM?: boolean } = {},
): Promise<MovimientoConSugerencia[]> {
  const { start, end } = monthRange(year, month);

  const txs = (await prisma.bankTransaction.findMany({
    where: {
      companyId,
      status: "UNMATCHED", // sin conciliar
      invoiceId: null, // sin CFDI
      fecha: { gte: start, lt: end },
    },
    orderBy: { fecha: "asc" },
    select: { id: true, fecha: true, descripcion: true, monto: true, bankAccountId: true },
  })).map((t) => ({ ...t, monto: Number(t.monto) }));

  const out: MovimientoConSugerencia[] = [];
  for (const tx of txs) {
    const signo = signoDeMonto(tx.monto);
    let sugerencia: MovimientoConSugerencia["sugerencia"] = null;

    const porReglas = sugerirCategoriaConcepto(tx.descripcion, signo);
    if (porReglas) {
      sugerencia = { ...porReglas, fuenteSugerencia: "reglas" };
    } else if (opts.usarLLM) {
      const porLLM = await sugerirCategoriaConceptoLLM(tx.descripcion, signo, { companyId });
      if (porLLM) sugerencia = { ...porLLM, fuenteSugerencia: "llm" };
    }

    out.push({
      transaction: tx,
      sugerencia,
      deepLink: `/bancos/${tx.bankAccountId}?tx=${tx.id}&sugerencia=${sugerencia?.familia ?? ""}`,
    });
  }

  return out;
}

// Construye la partida doble para una familia + signo, espejando exactamente la
// lógica BANCO de postMonth(). Devuelve los dos renglones (cargo/abono) ya con
// los chartAccountId resueltos.
async function construirAsiento(
  companyId: string,
  familia: FamiliaConcepto,
  isCredit: boolean,
): Promise<{ chartAccountId: string; tipo: EntryType }[]> {
  const accBancos = await resolveAccount(companyId, COE_CODES.BANCOS);

  // Para gastos/impuestos/nómina/renta: cuando sale dinero (débito) cargamos el
  // gasto y abonamos Bancos. Si por alguna razón fuera un crédito (reverso/
  // devolución) invertimos.
  const contraCargoAbono = async (code: string) => {
    const acc = await resolveAccount(companyId, code);
    if (isCredit) {
      // entró dinero → DR Bancos / CR contracuenta
      return [
        { chartAccountId: accBancos.id, tipo: "CARGO" as EntryType },
        { chartAccountId: acc.id, tipo: "ABONO" as EntryType },
      ];
    }
    // salió dinero → DR contracuenta / CR Bancos
    return [
      { chartAccountId: acc.id, tipo: "CARGO" as EntryType },
      { chartAccountId: accBancos.id, tipo: "ABONO" as EntryType },
    ];
  };

  switch (familia) {
    case "COMISION":
      return contraCargoAbono(COE_CODES.COMISIONES_BANCARIAS);
    case "TAX_PAYMENT":
      return contraCargoAbono(COE_CODES.IMPUESTOS_DERECHOS);
    case "PAYROLL_NO_CFDI":
      return contraCargoAbono(COE_CODES.SUELDOS_SALARIOS);
    case "RENT":
      return contraCargoAbono(COE_CODES.RENTAS);
    case "NON_DEDUCTIBLE":
      return contraCargoAbono(COE_CODES.GASTOS_NO_DEDUCIBLES);
    case "FINANCIAL_INCOME":
      // Ingreso: entró dinero → DR Bancos / CR Otros ingresos.
      return contraCargoAbono(COE_CODES.OTROS_INGRESOS);
    case "INTERNAL_TRANSFER":
      // Traspaso entre cuentas propias: lavado contra la misma cuenta de Bancos
      // (v1 una sola cuenta), igual que postMonth.
      return [
        { chartAccountId: accBancos.id, tipo: "CARGO" as EntryType },
        { chartAccountId: accBancos.id, tipo: "ABONO" as EntryType },
      ];
  }
}

export type AprobarResult =
  | { ok: true; created: boolean; entries: number }
  | { ok: false; error: string; status: number };

/**
 * Aprueba una sugerencia para un movimiento: escribe el asiento (fuente BANCO)
 * de forma IDEMPOTENTE y marca el movimiento IGNORED con la familia en `notes`.
 *
 * Idempotencia: si ya existen asientos para ese movimiento (referencia = txId,
 * referenciaTipo = BANK_TX, fuente = BANCO) no crea duplicados.
 *
 * @param familia  Familia elegida por el usuario (normalmente la sugerida).
 */
export async function aprobarSugerencia(
  txId: string,
  familia: FamiliaConcepto,
): Promise<AprobarResult> {
  const tx = await prisma.bankTransaction.findUnique({
    where: { id: txId },
    include: { conciliacionDetalles: { select: { id: true }, take: 1 } },
  });
  if (!tx) return { ok: false, error: "Movimiento no encontrado", status: 404 };
  if (tx.invoiceId || tx.conciliacionDetalles.length > 0) {
    return { ok: false, error: "El movimiento ya está conciliado con un CFDI", status: 409 };
  }

  const companyId = tx.companyId;
  const fecha = tx.fecha;
  const year = fecha.getUTCFullYear();
  const month = fecha.getUTCMonth() + 1;
  const monto = Number(tx.monto);
  const absAmount = Math.abs(monto);
  const isCredit = monto > 0;

  if (absAmount <= 0) {
    return { ok: false, error: "El movimiento no tiene importe", status: 422 };
  }

  // No escribir en periodos ya cerrados.
  const period = await prisma.accountingPeriod.findUnique({
    where: { companyId_year_month: { companyId, year, month } },
    select: { id: true, status: true },
  });
  if (period && period.status === "CLOSED") {
    return { ok: false, error: "El periodo ya está cerrado", status: 409 };
  }

  // Idempotencia: ¿ya hay asientos BANCO para este movimiento?
  const existing = await prisma.accountingEntry.count({
    where: { companyId, referencia: txId, referenciaTipo: "BANK_TX", fuente: "BANCO" },
  });
  if (existing > 0) {
    // Aseguramos al menos que el movimiento quede etiquetado y devolvemos éxito.
    await prisma.bankTransaction.update({
      where: { id: txId },
      data: { status: "IGNORED", invoiceId: null, notes: familia },
    });
    return { ok: true, created: false, entries: existing };
  }

  let renglones: { chartAccountId: string; tipo: EntryType }[];
  try {
    renglones = await construirAsiento(companyId, familia, isCredit);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "No se pudo resolver la cuenta",
      status: 422,
    };
  }

  await prisma.$transaction(async (db) => {
    const periodRow = await db.accountingPeriod.upsert({
      where: { companyId_year_month: { companyId, year, month } },
      update: {},
      create: { companyId, year, month, status: "DRAFT" },
    });

    await db.accountingEntry.createMany({
      data: renglones.map((r) => ({
        companyId,
        chartAccountId: r.chartAccountId,
        year,
        month,
        periodId: periodRow.id,
        fecha,
        descripcion: tx.descripcion.substring(0, 200),
        referencia: txId,
        referenciaTipo: "BANK_TX",
        monto: absAmount,
        tipo: r.tipo,
        fuente: "BANCO" as EntrySource,
      })),
    });

    // Marca el movimiento como categorizado: IGNORED + etiqueta de familia, la
    // misma que postMonth lee de `notes`, para que el cierre regenere el mismo
    // asiento en lugar de bloquear el mes por "sin conciliar".
    await db.bankTransaction.update({
      where: { id: txId },
      data: { status: "IGNORED", invoiceId: null, notes: familia },
    });
  });

  return { ok: true, created: true, entries: renglones.length };
}
