import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const A = "itest-accounting-tools-a", B = "itest-accounting-tools-b", U = "itest-accounting-tools-owner", V = "itest-accounting-tools-viewer";
let actor = U;
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: actor } }) }));
vi.mock("@/lib/subscription", () => ({ gateEscritura: async () => null }));
// Exercise the real posting engine; close readiness has separate integration coverage.
vi.mock("@/lib/cierre/compuerta-contabilizacion", () => ({ evaluarCompuertaContabilizacion: async () => ({ ok: true }), invalidarCompuertaContabilizacion: vi.fn() }));
import { prisma } from "@/lib/prisma";
import { POST, DELETE } from "@/app/api/ai/confirm/route";
import { executeAccountingRead } from "./accounting-executor";
import { proposeAccounting, revertLoanPosting } from "./accounting-proposals";
import { getChatPendingAction } from "./pending-action";
import { postMonth } from "@/lib/contabilidad/posting";
import { seedChartOfAccounts } from "@/lib/contabilidad/seed-catalog";

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { companyId: { in: [A, B] } } });
  await prisma.bankTransaction.deleteMany({ where: { companyId: { in: [A, B] } } });
  await prisma.company.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.user.deleteMany({ where: { id: { in: [U, V] } } });
}
async function proposal(name: string, args: Record<string, unknown>, conversationId = "accounting-tools-conv") {
  return JSON.parse(await proposeAccounting(name, args, A, { inApp: true, conversationId }));
}
async function confirm(token: string, method = "POST") {
  const req = new Request("http://localhost/api/ai/confirm", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: "accounting-tools-conv", token }) });
  return (method === "DELETE" ? DELETE : POST)(req);
}
async function movement(id = "accounting-tools-tx", monto = -1000) {
  return prisma.bankTransaction.create({ data: { id, companyId: A, bankAccountId: "accounting-tools-bank", fecha: new Date("2026-09-15T12:00:00Z"), descripcion: "Synthetic documented loan", tipo: monto < 0 ? "DEBITO" : "CREDITO", monto } });
}
const loanInput = { transaction_id: "accounting-tools-tx", chart_account_id: "accounting-tools-debtor", familia: "LOAN_GIVEN" };

describe.skipIf(process.env.DB_TESTS_SKIP === "1")("accounting chat tools against Postgres", () => {
  beforeEach(async () => {
    await cleanup(); actor = U;
    await prisma.user.createMany({ data: [{ id: U, email: "accounting-tools-owner@test.local" }, { id: V, email: "accounting-tools-viewer@test.local" }] });
    await prisma.company.createMany({ data: [A, B].map((id, index) => ({ id, rfc: `ACT26090${index}AA1`, razonSocial: id, regimenFiscal: "601", codigoPostal: "06600" })) });
    await prisma.companyMember.createMany({ data: [{ companyId: A, userId: U, role: "OWNER" }, { companyId: A, userId: V, role: "VIEWER" }] });
    await seedChartOfAccounts(A);
    await prisma.chartAccount.createMany({ data: [
      { id: "accounting-tools-parent", companyId: A, cuentaSAT: "1170", nombre: "Synthetic debtors", tipo: "ACTIVO", naturaleza: "D", codAgrup: "107.05" },
      { id: "accounting-tools-debtor", companyId: A, cuentaSAT: "1170", subcuenta: "1170-001", padreCodigo: "1170", nivel: 2, nombre: "Synthetic counterparty", tipo: "ACTIVO", naturaleza: "D", codAgrup: "107.05" },
      { id: "accounting-tools-creditor", companyId: A, cuentaSAT: "2130", subcuenta: "2130-001", nombre: "Synthetic counterparty", tipo: "PASIVO", naturaleza: "A", codAgrup: "205.02" },
      { id: "accounting-tools-bank-ledger", companyId: A, cuentaSAT: "1010", subcuenta: "1010-001", nombre: "Synthetic bank", tipo: "ACTIVO", naturaleza: "D", codAgrup: "102.01" },
      { id: "accounting-tools-foreign", companyId: B, cuentaSAT: "1170", subcuenta: "1170-001", nombre: "Foreign counterparty", tipo: "ACTIVO", naturaleza: "D", codAgrup: "107.05" },
    ] });
    await prisma.bankAccount.create({ data: { id: "accounting-tools-bank", companyId: A, banco: "Synthetic", nombre: "Test", numeroCuenta: "SYNTHETIC-1", chartAccountId: "accounting-tools-bank-ledger" } });
    await prisma.chatConversation.create({ data: { id: "accounting-tools-conv", companyId: A, userId: U, visibility: "COMPANY" } });
  });
  afterAll(cleanup);

  it("separates current/historical CE and local ledger; no evidence is not zero and debtors are not netted against creditors", async () => {
    await prisma.ceBalanzaMes.createMany({ data: [
      { companyId: A, anio: 2026, mes: 7, numCta: "1170-001", saldoIni: 900, debe: 0, haber: 0, saldoFin: 900 },
      { companyId: A, anio: 2026, mes: 9, numCta: "1170-001", saldoIni: 300, debe: 0, haber: 0, saldoFin: 300 },
      { companyId: B, anio: 2026, mes: 9, numCta: "1170-001", saldoIni: 9999, debe: 0, haber: 0, saldoFin: 9999 },
    ] });
    for (const [month, tipo, monto] of [[8, "CARGO", 1000], [9, "CARGO", 200], [9, "ABONO", 50]] as const) {
      await prisma.accountingEntry.create({ data: { companyId: A, chartAccountId: "accounting-tools-debtor", year: 2026, month, fecha: new Date(`2026-${month.toString().padStart(2, "0")}-15`), descripcion: "Synthetic", tipo, monto, fuente: "MANUAL" } });
    }
    const result = JSON.parse(await executeAccountingRead("query_saldos_cuentas", { year: 2026, month: 9, cuentas: ["1170-001", "2130-001"] }, A));
    expect(result.accounts).toHaveLength(2);
    const debtor = result.accounts.find((a: { id: string }) => a.id === "accounting-tools-debtor");
    expect(debtor.importedCe).toMatchObject({ month: 9, saldoFinal: 300, source: "BALANZA_CE_IMPORTADA" });
    expect(debtor.previousImportedCe).toMatchObject({ month: 7, saldoFinal: 900 });
    expect(debtor.localLedger).toMatchObject({ saldoInicial: 1000, saldoFinal: 1150, cargos: 200, abonos: 50, provisional: true });
    expect(result.accounts.find((a: { id: string }) => a.id === "accounting-tools-creditor").localLedger).toBeNull();
    const history = JSON.parse(await executeAccountingRead("query_auxiliar_cuenta", { year: 2026, month: 9, chart_account_id: debtor.id, limit: 1 }, A));
    expect(history.entries).toHaveLength(1); expect(history.truncated).toBe(true);
    expect(JSON.parse(await executeAccountingRead("query_auxiliar_cuenta", { year: 2026, month: 9, chart_account_id: "accounting-tools-foreign" }, A))).toHaveProperty("error");
  });

  it("creates and renames accounts only after confirmation, retaining existing history", async () => {
    const created = await proposal("proponer_crear_subcuenta", { chart_account_id: "accounting-tools-parent", codigo: "1170-002", nombre: "Synthetic new debtor" });
    expect(created.pending).toBe(true);
    expect(await prisma.chartAccount.count({ where: { companyId: A, subcuenta: "1170-002" } })).toBe(0);
    expect((await confirm(created.token)).status).toBe(200);
    const account = await prisma.chartAccount.findFirstOrThrow({ where: { companyId: A, subcuenta: "1170-002" } });
    expect(account).toMatchObject({ padreCodigo: "1170", tipo: "ACTIVO", naturaleza: "D", codAgrup: "107.05", nivel: 2 });
    expect(await prisma.accountingEntry.count({ where: { companyId: A } })).toBe(0);
    const renamed = await proposal("proponer_renombrar_cuenta", { chart_account_id: account.id, nombre: "Synthetic corrected name" });
    expect((await confirm(renamed.token)).status).toBe(200);
    expect(await prisma.chartAccount.findUnique({ where: { id: account.id } })).toMatchObject({ subcuenta: "1170-002", nombre: "Synthetic corrected name" });
  });

  it("does not overwrite pending proposals, cancels durably, and rejects viewers and double confirmation", async () => {
    const one = await proposal("proponer_renombrar_cuenta", { chart_account_id: "accounting-tools-debtor", nombre: "First proposal" });
    const two = await proposal("proponer_renombrar_cuenta", { chart_account_id: "accounting-tools-debtor", nombre: "Second proposal" });
    expect(two.error).toContain("pendiente");
    expect((await getChatPendingAction("accounting-tools-conv"))?.token).toBe(one.token);
    actor = V; expect((await confirm(one.token)).status).toBe(403); actor = U;
    expect((await confirm(one.token, "DELETE")).status).toBe(200);
    expect(await getChatPendingAction("accounting-tools-conv")).toBeNull();
    const next = await proposal("proponer_renombrar_cuenta", { chart_account_id: "accounting-tools-debtor", nombre: "Confirmed once" });
    const results = await Promise.all([confirm(next.token), confirm(next.token)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.auditLog.count({ where: { companyId: A, accion: "ai.renombrar_cuenta", entidadId: next.token } })).toBe(1);
  });

  it("rejects stale account/movement evidence, closed periods, foreign accounts and foreign currency", async () => {
    await movement();
    expect((await proposal("proponer_registro_prestamo", { ...loanInput, chart_account_id: "accounting-tools-foreign" })).error).toBeTruthy();
    const staged = await proposal("proponer_registro_prestamo", loanInput);
    await prisma.bankTransaction.update({ where: { id: "accounting-tools-tx" }, data: { monto: -2000 } });
    expect((await confirm(staged.token)).status).toBe(409);
    expect(await prisma.accountingEntry.count({ where: { companyId: A } })).toBe(0);
    await prisma.accountingPeriod.create({ data: { companyId: A, year: 2026, month: 9, status: "CLOSED" } });
    expect((await proposal("proponer_registro_prestamo", loanInput)).error).toBeTruthy();
    await prisma.accountingPeriod.updateMany({ where: { companyId: A }, data: { status: "DRAFT" } });
    await prisma.bankAccount.update({ where: { id: "accounting-tools-bank" }, data: { moneda: "USD" } });
    expect((await proposal("proponer_registro_prestamo", loanInput)).error).toContain("MXN");
    const rename = await proposal("proponer_renombrar_cuenta", { chart_account_id: "accounting-tools-debtor", nombre: "Outdated suggestion" });
    await prisma.chartAccount.update({ where: { id: "accounting-tools-debtor" }, data: { nombre: "Updated by accountant" } });
    expect((await confirm(rename.token)).status).toBe(409);
    expect((await prisma.chartAccount.findUniqueOrThrow({ where: { id: "accounting-tools-debtor" } })).nombre).toBe("Updated by accountant");
  });

  it("posts the exact loan accounts once, preserves them on monthly regeneration and reverses them together", async () => {
    await movement();
    const staged = await proposal("proponer_registro_prestamo", loanInput);
    expect(staged.summary).toContain("1170-001"); expect(staged.summary).toContain("1010-001");
    expect(await prisma.accountingEntry.count({ where: { companyId: A } })).toBe(0);
    expect((await confirm(staged.token)).status).toBe(200);
    const entries = () => prisma.accountingEntry.findMany({ where: { companyId: A, referencia: "accounting-tools-tx" }, orderBy: { tipo: "asc" } });
    const expected = [{ chartAccountId: "accounting-tools-bank-ledger", tipo: "ABONO", monto: 1000 }, { chartAccountId: "accounting-tools-debtor", tipo: "CARGO", monto: 1000 }];
    const normalize = (rows: Awaited<ReturnType<typeof entries>>) => rows.map((row) => ({ chartAccountId: row.chartAccountId, tipo: row.tipo, monto: Number(row.monto) })).sort((a, b) => a.chartAccountId.localeCompare(b.chartAccountId));
    expect(normalize(await entries())).toEqual(expected);
    expect(await prisma.accountingPeriod.findUnique({ where: { companyId_year_month: { companyId: A, year: 2026, month: 9 } } })).toMatchObject({ entriesCount: 2 });
    await postMonth({ companyId: A, year: 2026, month: 9 });
    expect(normalize(await entries())).toEqual(expected);
    await prisma.accountingPeriod.updateMany({ where: { companyId: A }, data: { status: "CLOSED" } });
    await expect(revertLoanPosting(A, "accounting-tools-tx", U)).rejects.toThrow();
    expect(await entries()).toHaveLength(2);
    await prisma.accountingPeriod.updateMany({ where: { companyId: A }, data: { status: "POSTED" } });
    await revertLoanPosting(A, "accounting-tools-tx", U);
    expect(await entries()).toHaveLength(0);
    expect(await prisma.bankTransaction.findUnique({ where: { id: "accounting-tools-tx" } })).toMatchObject({ status: "UNMATCHED", loanAccountId: null });
    expect(await prisma.accountingPeriod.findUnique({ where: { companyId_year_month: { companyId: A, year: 2026, month: 9 } } })).toMatchObject({ entriesCount: 0 });
  });
});
