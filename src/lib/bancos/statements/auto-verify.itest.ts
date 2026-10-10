import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/cron-scheduler", () => ({ kickCron: vi.fn() }));
import { prisma } from "@/lib/prisma";
import { persistStatementTransactions } from "./ingest";
import { accountReview } from "./review";
import { autoVerificarEstado, diagnosticarEstado, estadosPorRevisar, MOTIVO_AUTOMATICO } from "./auto-verify";
import type { ParsedTransaction } from "@/lib/bank-parser";

const A = "itest-auto-verify", U = "itest-auto-verify-user", BANK = A + "-bank";
const row = (amount: number, id: string, date: string): ParsedTransaction => ({ fecha: new Date(date + "T12:00:00Z"), monto: amount, descripcion: "Synthetic " + id, bankReferenceId: id });

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { companyId: A } });
  await prisma.bankTransaction.deleteMany({ where: { companyId: A } });
  await prisma.company.deleteMany({ where: { id: A } });
  await prisma.user.deleteMany({ where: { id: U } });
}
/** Un PDF de un mes completo con sus controles impresos (como los deja upload.ts). */
async function estado(nombre: string, mes: string, txs: ParsedTransaction[], extra: Record<string, unknown> = {}) {
  const credits = txs.filter((t) => t.monto > 0).reduce((s, t) => s + t.monto, 0);
  const debits = -txs.filter((t) => t.monto < 0).reduce((s, t) => s + t.monto, 0);
  const [y, m] = mes.split("-").map(Number);
  return persistStatementTransactions({ companyId: A, bankAccountId: BANK, userId: U, transactions: txs, source: "UPLOAD_PDF", periodo: mes,
    archivo: { bytes: Buffer.from(nombre), nombre, mime: "application/pdf" }, saldoInicial: 1000, saldoFinal: 1000 + credits - debits,
    periodStart: `${mes}-01`, periodEnd: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), declaredAccount: "****1234", declaredCurrency: "MXN",
    controls: { credits, debits, creditCount: txs.filter((t) => t.monto > 0).length, debitCount: txs.filter((t) => t.monto < 0).length }, ...extra });
}

describe.skipIf(process.env.DB_TESTS_SKIP === "1")("verificación automática de estados", () => {
  beforeEach(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: U, email: "auto-verify@test.invalid" } });
    await prisma.company.create({ data: { id: A, rfc: "AVE250101AA1", razonSocial: A, regimenFiscal: "601", codigoPostal: "06600" } });
    await prisma.companyMember.create({ data: { companyId: A, userId: U, role: "OWNER" } });
    await prisma.bankAccount.create({ data: { id: BANK, companyId: A, banco: "Synthetic", nombre: "Auto", numeroCuenta: "00001234" } });
  });
  afterAll(cleanup);

  it("verifica solo el estado que cuadra al centavo y registra que fue automático", async () => {
    const doc = await estado("marzo.pdf", "2025-03", [row(500, "a", "2025-03-03"), row(-120.5, "b", "2025-03-20")]);
    const d = await autoVerificarEstado(A, doc.batchId, U);
    expect(d).toMatchObject({ verificado: true, periodo: "2025-03" });
    const review = await accountReview({ companyId: A, bankAccountId: BANK, year: 2025, month: 3 });
    expect(review.status).toBe("VERIFIED");
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: doc.batchId } });
    expect((batch.reviewAttestation as { reason: string }).reason).toBe(MOTIVO_AUTOMATICO);
    expect(await prisma.auditLog.count({ where: { companyId: A, accion: "bancos.statement.verify" } })).toBe(1);
  });

  it("no verifica si los totales impresos no coinciden y dice por qué", async () => {
    const doc = await estado("abril.pdf", "2025-04", [row(500, "c", "2025-04-03")], { controls: { credits: 600, debits: 0, creditCount: 1, debitCount: 0 } });
    const d = await autoVerificarEstado(A, doc.batchId, U);
    expect(d.verificado).toBe(false);
    expect(d.motivos.join(" ")).toMatch(/abonos/);
    expect((await accountReview({ companyId: A, bankAccountId: BANK, year: 2025, month: 4 })).verified).toBeNull();
  });

  it("sin totales impresos (p. ej. una foto) queda por revisar", async () => {
    const doc = await estado("mayo.jpg", "2025-05", [row(100, "d", "2025-05-03")], { controls: null });
    const d = await diagnosticarEstado(A, doc.batchId);
    expect(d.listo).toBe(false);
    expect(d.motivos[0]).toMatch(/totales de abonos y cargos/);
  });

  it("la cuenta impresa distinta bloquea la verificación", async () => {
    const doc = await estado("junio.pdf", "2025-06", [row(100, "e", "2025-06-03")], { declaredAccount: "****9999" });
    expect((await autoVerificarEstado(A, doc.batchId, U)).motivos.join(" ")).toMatch(/cuenta impresa/);
  });

  it("la lista de pendientes junta todos los meses y omite los verificados", async () => {
    const ok = await estado("julio.pdf", "2025-07", [row(100, "f", "2025-07-03")]);
    await autoVerificarEstado(A, ok.batchId, U);
    const mal = await estado("agosto.pdf", "2025-08", [row(100, "g", "2025-08-03")], { saldoFinal: 5 });
    const lista = await estadosPorRevisar(A);
    expect(lista.map((p) => p.batchId)).toEqual([mal.batchId]);
    expect(lista[0]).toMatchObject({ periodo: "2025-08", year: 2025, month: 8, archivoNombre: "agosto.pdf" });
    expect(lista[0].motivos.join(" ")).toMatch(/saldo final/i);
  });
});
