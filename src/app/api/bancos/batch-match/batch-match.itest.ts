import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const A = "itest-batch-match", U = "itest-batch-match-user";
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: U } }) }));
import { prisma } from "@/lib/prisma";
import { POST } from "./route";

const BANK = A + "-bank";
async function cleanup() {
  await prisma.bankTransaction.deleteMany({ where: { companyId: A } });
  await prisma.company.deleteMany({ where: { id: A } });
  await prisma.user.deleteMany({ where: { id: U } });
}
const llamar = (txIds: string[], invoiceId: string) =>
  POST(new Request("http://t/api/bancos/batch-match", { method: "POST", body: JSON.stringify({ txIds, invoiceId }) }));
async function tx(id: string, monto: number) {
  await prisma.bankTransaction.create({ data: { id, companyId: A, bankAccountId: BANK, fecha: new Date("2025-09-10T12:00:00Z"), monto, descripcion: "pago " + id, tipo: monto > 0 ? "CREDITO" : "DEBITO", status: "UNMATCHED" } });
}

describe.skipIf(process.env.DB_TESTS_SKIP === "1")("batch-match: varios pagos ↔ una factura", () => {
  let invoiceId = "";
  beforeEach(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: U, email: "batch-match@test.invalid" } });
    await prisma.company.create({ data: { id: A, rfc: "BMT250101AA1", razonSocial: A, regimenFiscal: "601", codigoPostal: "06600" } });
    await prisma.companyMember.create({ data: { companyId: A, userId: U, role: "OWNER" } });
    await prisma.bankAccount.create({ data: { id: BANK, companyId: A, banco: "Synthetic", nombre: "BM", numeroCuenta: "00001234" } });
    invoiceId = (await prisma.invoice.create({ data: { companyId: A, uuid: A + "-inv", tipo: "INGRESO", status: "STAMPED", fecha: new Date("2025-09-01"), contraparteRfc: "AAA010101AAA", contraparteNombre: "Paciente", subtotal: 1000, total: 1000, formaPago: "03", metodoPago: "PPD", usoCfdi: "G03", moneda: "MXN" } })).id;
    await tx("bm-a", 400); await tx("bm-b", 600); await tx("bm-c", 300);
  });
  afterAll(cleanup);

  it("concilia los abonos que cubren la factura", async () => {
    const r = await llamar(["bm-a", "bm-b"], invoiceId);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, matched: 2, sumMatched: 1000, coverage: 1 });
  });

  it("frena el sobrepago, contando lo ya cobrado por otros movimientos", async () => {
    expect((await llamar(["bm-a", "bm-b", "bm-c"], invoiceId)).status).toBe(400);
    expect((await llamar(["bm-a", "bm-b"], invoiceId)).status).toBe(200);
    const r = await llamar(["bm-c"], invoiceId);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/le quedan 0\.00/);
    expect((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: "bm-c" } })).status).toBe("UNMATCHED");
  });
});
