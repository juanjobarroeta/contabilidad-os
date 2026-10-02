import { createHash, randomUUID } from "node:crypto";
import { statementPostingGate } from "@/lib/bancos/statements/review";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CODIGO_AGRUPADOR_OFICIAL } from "@/lib/contabilidad/codigo-agrupador";
import { loanLines, validLoanAccount, type LoanFamily } from "@/lib/contabilidad/loan-posting";
import { assertPeriodoAbierto } from "@/lib/contabilidad/candado";
import { stageChatPendingAction, type ChatPendingAction, type ExecuteResult } from "./pending-action";
import type { ToolContext } from "./tool-executor";

export type AccountingProposal =
  | { type: "crear_subcuenta"; payload: { id: string; parentId: string; code: string; name: string; expected: string } }
  | { type: "renombrar_cuenta"; payload: { accountId: string; name: string; expected: string } }
  | { type: "registrar_prestamo"; payload: { txId: string; accountId: string; family: LoanFamily; expected: string } };
const fingerprint = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const fail = (error: string) => ({ ok: false as const, error });
type Db = Prisma.TransactionClient;
const codeOf = (account: { cuentaSAT: string; subcuenta: string | null }) => account.subcuenta ?? account.cuentaSAT;

async function readLoan(db: Db, companyId: string, txId: string, accountId: string, family: LoanFamily) {
  const [movement, account] = await Promise.all([
    db.bankTransaction.findFirst({ where: { id: txId, companyId }, include: { bankAccount: { include: { chartAccount: true } },
      conciliacionDetalles: { select: { id: true } }, devolucionPor: { select: { id: true } },
      gastoPagado: { select: { id: true } }, reembolsoPagado: { select: { id: true } }, rayaPagada: { select: { id: true } }, solicitudCompraPagada: { select: { id: true } },
      adjudicacionPagada: { select: { id: true } }, hospLiquidacion: { select: { id: true } }, estimacionCobrada: { select: { id: true } },
      reservacionCobrada: { select: { id: true } }, compraRestPagada: { select: { id: true } }, ordenRestCobrada: { select: { id: true } },
      purifVentaCobrada: { select: { id: true } }, purifGastoPagado: { select: { id: true } }, purifCompraPagada: { select: { id: true } },
      salCompraPagada: { select: { id: true } }, salPagoRecibido: { select: { id: true } },
    } }),
    db.chartAccount.findFirst({ where: { id: accountId, companyId, isActive: true } }),
  ]);
  if (!movement || !account) throw new Error("Movimiento o cuenta no encontrados en esta empresa.");
  if (movement.bankAccount.moneda !== "MXN") throw new Error("El registro de préstamos del chat sólo admite movimientos en MXN; falta definir la conversión cambiaria.");
  if (!validLoanAccount(family, account)) throw new Error("La cuenta debe ser un auxiliar de deudores (107) o acreedores (205/251) de la familia elegida, con agrupador SAT válido.");
  const bank = movement.bankAccount.chartAccount;
  if (!bank?.isActive || bank.companyId !== companyId || bank.tipo !== "ACTIVO" || !/^102(?:\.|$)/.test(bank.codAgrup ?? bank.subcuenta ?? bank.cuentaSAT)) {
    throw new Error("Vincula primero la cuenta bancaria con su cuenta del catálogo en Contabilidad. No se elegirá una cuenta de banco genérica.");
  }
  const children = await db.chartAccount.count({ where: { companyId, isActive: true, padreCodigo: codeOf(account) } });
  if (children) throw new Error("Elige la subcuenta de la contraparte; esta cuenta tiene auxiliares.");
  const expected = fingerprint({ txId, fecha: movement.fecha, monto: Number(movement.monto), description: movement.descripcion,
    currency: movement.bankAccount.moneda,
    status: movement.status, notes: movement.notes, loanAccountId: movement.loanAccountId,
    account: { id: account.id, code: codeOf(account), name: account.nombre, grouping: account.codAgrup },
    bank: { id: bank.id, code: codeOf(bank), name: bank.nombre } });
  return { movement, account, bank, expected };
}
function assertUnassigned(m: Awaited<ReturnType<typeof readLoan>>["movement"]) {
  if (m.status !== "UNMATCHED" || m.invoiceId || m.taxDeclarationId || m.conciliacionDetalles.length || m.devolucionDeId || m.devolucionPor ||
    m.gastoPagado || m.reembolsoPagado || m.rayaPagada || m.solicitudCompraPagada || m.adjudicacionPagada || m.hospLiquidacion ||
    m.estimacionCobrada || m.reservacionCobrada || m.compraRestPagada || m.ordenRestCobrada || m.purifVentaCobrada ||
    m.purifGastoPagado || m.purifCompraPagada || m.salCompraPagada || m.salPagoRecibido || m.comisionDeId) throw new Error("El movimiento ya tiene una aplicación. Revísala antes de proponer otra.");
}

async function refreshPeriodTotals(db: Db, companyId: string, year: number, month: number) {
  const sums = await db.accountingEntry.groupBy({ by: ["tipo"], where: { companyId, year, month }, _sum: { monto: true }, _count: { _all: true } });
  await db.accountingPeriod.update({ where: { companyId_year_month: { companyId, year, month } }, data: {
    entriesCount: sums.reduce((sum, row) => sum + row._count._all, 0),
    totalCargos: sums.find((row) => row.tipo === "CARGO")?._sum.monto ?? 0,
    totalAbonos: sums.find((row) => row.tipo === "ABONO")?._sum.monto ?? 0,
  } });
}

/** The bank page's existing undo action reverses only this movement's entries. */
export async function revertLoanPosting(companyId: string, txId: string, userId: string) {
  return prisma.$transaction(async (db) => {
    await db.$queryRaw`SELECT id FROM "Company" WHERE id = ${companyId} FOR UPDATE`;
    const movement = await db.bankTransaction.findFirstOrThrow({ where: { id: txId, companyId } });
    if (!movement.loanAccountId) return;
    const year = movement.fecha.getUTCFullYear(), month = movement.fecha.getUTCMonth() + 1;
    const period = await db.accountingPeriod.upsert({ where: { companyId_year_month: { companyId, year, month } }, create: { companyId, year, month }, update: {} });
    await db.$queryRaw`SELECT id FROM "AccountingPeriod" WHERE id = ${period.id} FOR UPDATE`;
    await assertPeriodoAbierto(db, companyId, year, month);
    await db.accountingEntry.deleteMany({ where: { companyId, referencia: txId, referenciaTipo: "BANK_TX", fuente: "BANCO" } });
    await db.bankTransaction.update({ where: { id: txId }, data: { status: "UNMATCHED", notes: null, loanAccountId: null } });
    await refreshPeriodTotals(db, companyId, year, month);
    await db.auditLog.create({ data: { companyId, userId, accion: "contabilidad.prestamo.revertir", entidad: "BankTransaction", entidadId: txId,
      detalle: { accountId: movement.loanAccountId, family: movement.notes } } });
  }, { isolationLevel: "Serializable", timeout: 120000 });
}

export async function proposeAccounting(name: string, input: Record<string, unknown>, companyId: string, context: ToolContext) {
  if (!context.inApp || !context.conversationId) return JSON.stringify({ error: "Esta propuesta requiere confirmación en el chat de la app." });
  try {
    let action: AccountingProposal, summary: string;
    if (name === "proponer_registro_prestamo") {
      const family = input.familia as LoanFamily;
      if (family !== "LOAN_GIVEN" && family !== "LOAN_RECEIVED") throw new Error("Familia de préstamo inválida.");
      const row = await readLoan(prisma, companyId, String(input.transaction_id ?? ""), String(input.chart_account_id ?? ""), family);
      assertUnassigned(row.movement);
      await assertPeriodoAbierto(prisma, companyId, row.movement.fecha.getUTCFullYear(), row.movement.fecha.getUTCMonth() + 1);
      const entries = loanLines(row.bank.id, row.account.id, Number(row.movement.monto));
      summary = `Registrar capital de préstamo del ${row.movement.fecha.toISOString().slice(0, 10)} (${row.movement.descripcion}): ` +
        entries.map((line) => `${line.tipo === "CARGO" ? "Cargo" : "Abono"} $${line.monto.toFixed(2)} a ${line.chartAccountId === row.bank.id ? codeOf(row.bank) + " " + row.bank.nombre : codeOf(row.account) + " " + row.account.nombre}`).join("; ") + ". Sin calcular impuestos sobre este capital.";
      const gate = await statementPostingGate(companyId, row.movement.fecha.getUTCFullYear(), row.movement.fecha.getUTCMonth() + 1, prisma, row.movement.bankAccountId);
      if (!gate.ok) summary += " Se guardará como borrador con este auxiliar, sin asientos hasta verificar el estado completo.";
      action = { type: "registrar_prestamo", payload: { txId: row.movement.id, accountId: row.account.id, family, expected: row.expected } };
    } else {
      const account = await prisma.chartAccount.findFirst({ where: { id: String(input.chart_account_id ?? ""), companyId, isActive: true } });
      if (!account) throw new Error("Cuenta no encontrada en esta empresa.");
      const nextName = typeof input.nombre === "string" ? input.nombre.trim() : "";
      if (nextName.length < 2 || nextName.length > 150) throw new Error("Nombre de cuenta inválido.");
      const expected = fingerprint(account);
      if (name === "proponer_renombrar_cuenta") {
        summary = `Renombrar la cuenta ${codeOf(account)} de «${account.nombre}» a «${nextName}». Conserva el código, los movimientos y los saldos históricos.`;
        action = { type: "renombrar_cuenta", payload: { accountId: account.id, name: nextName, expected } };
      } else {
        const code = String(input.codigo ?? "").trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,79}$/.test(code) || code === codeOf(account)) throw new Error("Código de subcuenta inválido.");
        if (!account.codAgrup || !CODIGO_AGRUPADOR_OFICIAL[account.codAgrup]) throw new Error("El padre necesita un código agrupador oficial antes de crear una subcuenta.");
        if (await prisma.chartAccount.findFirst({ where: { companyId, OR: [{ subcuenta: code }, { cuentaSAT: code, subcuenta: null }] } })) throw new Error("Ese código ya existe. Consulta el catálogo antes de proponer otro.");
        summary = `Crear subcuenta ${code} «${nextName}» bajo ${codeOf(account)} «${account.nombre}», tipo ${account.tipo}, agrupador ${account.codAgrup}. Sin saldo inicial ni movimientos; no cambia cuentas existentes.`;
        action = { type: "crear_subcuenta", payload: { id: randomUUID(), parentId: account.id, code, name: nextName, expected } };
      }
    }
    const proposed = await stageChatPendingAction(context.conversationId, companyId, summary, action);
    return JSON.stringify({ pending: true, summary, token: proposed.token, instruction: "Pide confirmar esta tarjeta. No está ejecutado. Puede convivir con otras tarjetas pendientes." });
  } catch (error) { return JSON.stringify({ error: error instanceof Error && !error.name.startsWith("Prisma") ? error.message : "No se pudo preparar la propuesta." }); }
}

export async function executeAccountingProposal(pa: Extract<ChatPendingAction, { type: AccountingProposal["type"] }>, userId: string): Promise<ExecuteResult> {
  try {
    return await prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT id FROM "Company" WHERE id = ${pa.companyId} FOR UPDATE`;
      let deferred = false;
      if (pa.type === "registrar_prestamo") {
        const row = await readLoan(db, pa.companyId, pa.payload.txId, pa.payload.accountId, pa.payload.family);
        if (row.expected !== pa.payload.expected) return fail("La evidencia cambió. Pide una propuesta actualizada antes de registrar el préstamo.");
        assertUnassigned(row.movement);
        const year = row.movement.fecha.getUTCFullYear(), month = row.movement.fecha.getUTCMonth() + 1;
        const period = await db.accountingPeriod.upsert({ where: { companyId_year_month: { companyId: pa.companyId, year, month } }, create: { companyId: pa.companyId, year, month }, update: {} });
        // Updating/locking the period serializes with close/repost operations.
        await db.$queryRaw`SELECT id FROM "AccountingPeriod" WHERE id = ${period.id} FOR UPDATE`;
        await assertPeriodoAbierto(db, pa.companyId, year, month);
        if (await db.accountingEntry.count({ where: { companyId: pa.companyId, referencia: row.movement.id, referenciaTipo: "BANK_TX" } })) return fail("Ya existen asientos del movimiento. Revísalos antes de registrar otra vez.");
        const bankGate = await statementPostingGate(pa.companyId, year, month, db, row.movement.bankAccountId);
        deferred = !bankGate.ok;
        if (!deferred) await db.accountingEntry.createMany({ data: loanLines(row.bank.id, row.account.id, Number(row.movement.monto)).map((line) => ({ ...line,
          companyId: pa.companyId, fecha: row.movement.fecha, year, month, periodId: period.id,
          descripcion: row.movement.descripcion.slice(0, 200), referencia: row.movement.id, referenciaTipo: "BANK_TX", fuente: "BANCO",
        })) });
        await db.bankTransaction.update({ where: { id: row.movement.id }, data: { status: "IGNORED", notes: pa.payload.family, loanAccountId: row.account.id } });
        await refreshPeriodTotals(db, pa.companyId, year, month);
      } else {
        const accountId = pa.type === "crear_subcuenta" ? pa.payload.parentId : pa.payload.accountId;
        const account = await db.chartAccount.findFirst({ where: { id: accountId, companyId: pa.companyId, isActive: true } });
        if (!account || fingerprint(account) !== pa.payload.expected) return fail("La cuenta cambió. Pide una propuesta actualizada.");
        if (pa.type === "renombrar_cuenta") await db.chartAccount.update({ where: { id: account.id }, data: { nombre: pa.payload.name } });
        else {
          const existing = await db.chartAccount.findFirst({ where: { companyId: pa.companyId, OR: [{ subcuenta: pa.payload.code }, { cuentaSAT: pa.payload.code, subcuenta: null }] } });
          if (existing) return fail("La subcuenta ya existe. No se creó una copia.");
          if (!account.codAgrup || !CODIGO_AGRUPADOR_OFICIAL[account.codAgrup]) return fail("El padre ya no tiene agrupador oficial.");
          await db.chartAccount.create({ data: { id: pa.payload.id, companyId: pa.companyId, cuentaSAT: account.cuentaSAT, subcuenta: pa.payload.code,
            nombre: pa.payload.name, tipo: account.tipo, naturaleza: account.naturaleza, codAgrup: account.codAgrup, padreCodigo: codeOf(account), nivel: account.nivel + 1 } });
        }
      }
      await db.auditLog.create({ data: { companyId: pa.companyId, userId, accion: `ai.${pa.type}`, entidad: "ChatPendingAction", entidadId: pa.token,
        detalle: { summary: pa.summary, payload: pa.payload } as Prisma.InputJsonValue } });
      return { ok: true, message: deferred ? "Préstamo guardado como borrador con su auxiliar exacto. Falta verificar el estado completo antes de contabilizar." : pa.type === "registrar_prestamo" ? "Préstamo registrado en las cuentas confirmadas. Se conservan al regenerar el mes." : pa.type === "crear_subcuenta" ? "Subcuenta creada sin movimientos ni saldo inicial." : "Cuenta renombrada; código y movimientos conservados." };
    }, { isolationLevel: "Serializable", timeout: 120000 });
  } catch (error) {
    return fail(error instanceof Error && error.name.startsWith("Prisma") ? "La contabilidad cambió mientras se confirmaba. Revisa y genera otra propuesta." : error instanceof Error ? error.message : "No se pudo confirmar la propuesta.");
  }
}
