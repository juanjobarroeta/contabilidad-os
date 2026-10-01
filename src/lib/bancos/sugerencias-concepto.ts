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

import { statementPostingGate } from "./statements/review";
import { assertPeriodoAbierto } from "@/lib/contabilidad/candado";
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
import { motivoSinEvidencia } from "./traspaso-evidencia";
import { evidenciaTraspasoPorIds } from "./traspaso-evidencia-db";
import { registrarDecision, type ActorDecision } from "@/lib/decisiones";

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
  opts: { usarLLM?: boolean; maxLLM?: number; userId?: string | null } = {},
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

  // Tope de llamadas al modelo POR PETICIÓN: antes era una por movimiento sin
  // clasificar, sin límite (un mes con 400 movimientos = 400 llamadas por
  // cada recarga de la página). Lo que no alcanza queda sin sugerencia LLM y
  // se recoge en la siguiente petición.
  const maxLLM = opts.maxLLM ?? 25;
  let llamadasLLM = 0;
  const out: MovimientoConSugerencia[] = [];
  for (const tx of txs) {
    const signo = signoDeMonto(tx.monto);
    let sugerencia: MovimientoConSugerencia["sugerencia"] = null;

    const porReglas = sugerirCategoriaConcepto(tx.descripcion, signo);
    if (porReglas) {
      sugerencia = { ...porReglas, fuenteSugerencia: "reglas" };
    } else if (opts.usarLLM && llamadasLLM < maxLLM) {
      llamadasLLM++;
      const porLLM = await sugerirCategoriaConceptoLLM(tx.descripcion, signo, { companyId, userId: opts.userId });
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
    case "LOAN_RECEIVED":
      // Entra → nace la deuda; sale → la estamos pagando. contraCargoAbono ya
      // voltea por signo, igual que postMonth.
      return contraCargoAbono(COE_CODES.PRESTAMOS_RECIBIDOS);
    case "LOAN_GIVEN":
      return contraCargoAbono(COE_CODES.PRESTAMOS_OTORGADOS);
    case "IVA_COMISION":
      // Impuesto acreditable, no gasto. Va a PENDIENTE porque el CFDI del banco
      // (mensual) todavía no llega: sin comprobante el IVA aún no se acredita.
      return contraCargoAbono(COE_CODES.IVA_ACREDITABLE_PEND);
  }
}

export type AprobarResult =
  | { ok: true; created: boolean; entries: number; deferred?: boolean; message?: string }
  | { ok: false; error: string; status: number; sinEvidencia?: boolean };

export interface OpcionesAprobar {
  /**
   * Quién decide. Una persona en la mesa puede etiquetar un traspaso sin
   * evidencia (es su decisión y queda en el rastro); el motor —una regla
   * aplicada a otros movimientos— no.
   */
  actor?: ActorDecision;
  actorId?: string | null;
  /** Exigir evidencia de traspaso propio (lib/bancos/traspaso-evidencia). */
  exigirEvidencia?: boolean;
  /** Para el rastro: qué camino categorizó («mesa», «regla-retroactiva», «copiloto»…). */
  motor?: string;
}

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
  opts: OpcionesAprobar = {},
): Promise<AprobarResult> {
  const tx = await prisma.bankTransaction.findUnique({
    where: { id: txId },
    include: { conciliacionDetalles: { select: { id: true }, take: 1 } },
  });
  if (!tx) return { ok: false, error: "Movimiento no encontrado", status: 404 };
  if (tx.loanAccountId) return { ok: false, error: "Deshaz primero el préstamo registrado antes de cambiar su categoría.", status: 409 };
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

  // TRASPASO PROPIO: la evidencia decide si el motor puede etiquetarlo; si lo
  // etiqueta una persona, su decisión queda en el rastro con o sin evidencia.
  let rastroTraspaso: (() => void) | null = null;
  if (familia === "INTERNAL_TRANSFER") {
    const ev = (await evidenciaTraspasoPorIds(companyId, [txId])).get(txId);
    const actor = opts.actor ?? "motor";
    if (opts.exigirEvidencia && !ev?.tiene) {
      return {
        ok: false,
        error: `Sin evidencia de traspaso entre cuentas propias: ${ev ? motivoSinEvidencia(ev) : "no se pudo comprobar"}`,
        status: 422,
        sinEvidencia: true,
      };
    }
    // Se escribe sólo si la categorización se aplica (abajo, en cada éxito).
    rastroTraspaso = () => registrarDecision({
      companyId,
      entidad: "BankTransaction",
      entidadId: txId,
      motor: opts.motor ?? "categorizar",
      actor,
      actorId: opts.actorId ?? null,
      accion: "categorizar",
      resultado: { etiqueta: "INTERNAL_TRANSFER", conEvidencia: !!ev?.tiene },
      razones: ev?.tiene
        ? ev.razones
        : [{ regla: "traspaso.sin-evidencia", detalle: `etiquetado como traspaso propio por decisión ${actor === "usuario" ? "de una persona" : `del ${actor}`}; ${ev ? motivoSinEvidencia(ev) : "sin evidencia"}` }],
      refs: ev?.espejoId ? [ev.espejoId] : [],
    });
  }

  // No escribir en periodos ya cerrados.
  const period = await prisma.accountingPeriod.findUnique({
    where: { companyId_year_month: { companyId, year, month } },
    select: { id: true, status: true },
  });
  if (period && period.status === "CLOSED") {
    return { ok: false, error: "El periodo ya está cerrado", status: 409 };
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

  const result = await prisma.$transaction(async (db): Promise<AprobarResult> => {
    await db.$queryRaw`SELECT id FROM "Company" WHERE id = ${companyId} FOR UPDATE`;
    const periodRow = await db.accountingPeriod.upsert({
      where: { companyId_year_month: { companyId, year, month } }, update: {}, create: { companyId, year, month, status: "DRAFT" },
    });
    await db.$queryRaw`SELECT id FROM "AccountingPeriod" WHERE id = ${periodRow.id} FOR UPDATE`;
    await assertPeriodoAbierto(db, companyId, year, month);
    const current = await db.bankTransaction.findFirst({ where: { id: txId, companyId }, include: { conciliacionDetalles: { select: { id: true } } } });
    if (!current || current.loanAccountId || current.invoiceId || current.conciliacionDetalles.length || Number(current.monto) !== monto || current.fecha.getTime() !== fecha.getTime()) {
      return { ok: false, error: "El movimiento cambió. Revisa su registro antes de categorizarlo.", status: 409 };
    }
    const existing = await db.accountingEntry.count({ where: { companyId, referencia: txId, referenciaTipo: "BANK_TX", fuente: "BANCO" } });
    if (existing && current.notes !== familia) return { ok: false, error: "La categoría tiene asientos. Revisa la póliza antes de cambiarla.", status: 409 };
    const gate = await statementPostingGate(companyId, year, month, db, tx.bankAccountId);
    await db.bankTransaction.update({ where: { id: txId }, data: { status: "IGNORED", notes: familia } });
    if (!gate.ok) return { ok: true, created: false, entries: existing, deferred: true, message: "Clasificación guardada como borrador. Falta verificar el estado completo antes de contabilizar." };
    if (existing) return { ok: true, created: false, entries: existing };
    await db.accountingEntry.createMany({ data: renglones.map((r) => ({ companyId, chartAccountId: r.chartAccountId, year, month,
      periodId: periodRow.id, fecha, descripcion: tx.descripcion.substring(0, 200), referencia: txId,
      referenciaTipo: "BANK_TX", monto: absAmount, tipo: r.tipo, fuente: "BANCO" as EntrySource })) });
    return { ok: true, created: true, entries: renglones.length };
  }, { timeout: 120000 });
  if (result.ok) rastroTraspaso?.();
  return result;
}
