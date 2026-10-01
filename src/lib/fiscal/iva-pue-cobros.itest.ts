import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const A = "itest-pue-collection-a",
  B = "itest-pue-collection-b",
  U = "itest-pue-owner",
  V = "itest-pue-viewer";
let actor = U;
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: actor } }) }));
vi.mock("@/lib/cron-scheduler", () => ({ kickCron: vi.fn() }));
import { prisma } from "@/lib/prisma";
import { computeTaxPosition } from "@/lib/impuestos";
import { GET as paper } from "@/app/api/papeles/iva/route";
import { POST as review } from "@/app/api/facturas/[id]/iva-cobro/route";
import { GET as taxes, POST as saveTax } from "@/app/api/impuestos/route";
import { POST as fileFederal } from "@/app/api/impuestos/cierre/route";
import { executeToolCall } from "@/lib/ai/tool-executor";
import {
  loadPueIncomeCollections,
  pueInvoiceInclude,
  pueReviewToken,
} from "./iva-pue-cobros-db";
import { persistStatementTransactions } from "@/lib/bancos/statements/ingest";
import {
  accountReview,
  previewReview,
  executeReview,
  type ReviewOperation,
} from "@/lib/bancos/statements/review";
const sep = new Date("2026-09-01Z"),
  oct = new Date("2026-10-01Z");

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { companyId: { in: [A, B] } } });
  await prisma.bankTransaction.deleteMany({
    where: { companyId: { in: [A, B] } },
  });
  await prisma.company.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.user.deleteMany({ where: { id: { in: [U, V] } } });
}
async function invoice(
  opts: {
    companyId?: string;
    date?: string;
    interest?: boolean;
    total?: number;
    vat?: number;
  } = {},
) {
  return prisma.invoice.create({
    data: {
      companyId: opts.companyId ?? A,
      tipo: "INGRESO",
      tipoSat: "I",
      status: "STAMPED",
      uuid: randomUUID(),
      fecha: new Date((opts.date ?? "2026-10-01") + "T18:00:00Z"),
      formaPago: "03",
      metodoPago: "PUE",
      usoCfdi: "G03",
      moneda: "MXN",
      total: opts.total ?? 14500,
      subtotal: (opts.total ?? 14500) - (opts.vat ?? 2000),
      totalImpuestos: opts.vat ?? 2000,
      taxes: {
        create: {
          tipo: "IVA",
          factor: "TASA",
          tasa: 0.16,
          base: (opts.total ?? 14500) - (opts.vat ?? 2000),
          importe: opts.vat ?? 2000,
        },
      },
      items: {
        create: {
          cantidad: 1,
          claveUnidad: "E48",
          claveProdServ: opts.interest ? "84121500" : "81111500",
          descripcion: opts.interest
            ? "Intereses de mutuo"
            : "Synthetic service",
          valorUnitario: (opts.total ?? 14500) - (opts.vat ?? 2000),
          importe: (opts.total ?? 14500) - (opts.vat ?? 2000),
        },
      },
    },
  });
}
async function movement(
  invoiceId: string | null,
  amount = 14500,
  date = "2026-09-30",
  companyId = A,
) {
  return prisma.bankTransaction.create({
    data: {
      companyId,
      bankAccountId: companyId + "-bank",
      invoiceId,
      monto: amount,
      fecha: new Date(date + "T12:00:00Z"),
      bankReferenceId: randomUUID(),
      descripcion: "Synthetic PUE collection",
      tipo: amount > 0 ? "CREDITO" : "DEBITO",
      status: "MATCHED",
      source: "MANUAL",
    },
  });
}
async function confirm(id: string, extra: Record<string, unknown> = {}) {
  const inv = await prisma.invoice.findUniqueOrThrow({
    where: { id },
    include: pueInvoiceInclude,
  });
  return review(
    new Request("http://test.local/api/facturas/" + id + "/iva-cobro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: A,
        expected: pueReviewToken(inv),
        tratamiento: "FLUJO_GENERAL",
        fechaCobro: "2026-09-30",
        evidencia: "Synthetic bank receipt reviewed",
        motivo: "Reviewed evidence and ordinary cash-basis IVA treatment",
        ...extra,
      }),
    }),
    { params: Promise.resolve({ id }) },
  );
}
async function workpaper(month: number, format = "json") {
  return paper(
    new Request(
      `http://test.local/api/papeles/iva?companyId=${A}&year=2026&month=${month}&format=${format}`,
    ),
  );
}
async function declaration(month: number, trasladado: number) {
  return saveTax(
    new Request("http://test.local/api/impuestos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: A,
        periodo: `2026-${String(month).padStart(2, "0")}`,
        tipo: "IVA_MENSUAL",
        ivaData: {
          trasladado,
          acreditable: 0,
          pagar: trasladado,
          saldoFavor: 0,
        },
      }),
    }),
  );
}
async function filing(month: number, extra: Record<string, unknown> = {}) {
  return fileFederal(
    new Request("http://test.local/api/impuestos/cierre", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: A,
        periodo: `2026-${String(month).padStart(2, "0")}`,
        action: "file-federal",
        ...extra,
      }),
    }),
  );
}
async function verifyStatement(tx: Awaited<ReturnType<typeof movement>>) {
  const scope = {
    companyId: A,
    bankAccountId: A + "-bank",
    year: 2026,
    month: 9,
  };
  const batch = await persistStatementTransactions({
    ...scope,
    periodo: "2026-09",
    transactions: [
      {
        fecha: tx.fecha,
        monto: Number(tx.monto),
        descripcion: tx.descripcion,
        bankReferenceId: tx.bankReferenceId!,
      },
    ],
    archivo: {
      bytes: Buffer.from("Synthetic original statement for IVA test"),
      nombre: "synthetic.csv",
      mime: "text/csv",
    },
  });
  const operation: ReviewOperation = {
    type: "verify",
    batchId: batch.batchId,
    opening: 0,
    closing: Number(tx.monto),
    credits: Number(tx.monto),
    debits: 0,
    creditCount: 1,
    debitCount: 0,
    countsUnavailable: false,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    accountConfirmed: true,
    coverageConfirmed: true,
    originalReviewed: true,
    reason: "Synthetic original statement fully reviewed",
  };
  const request = {
    ...scope,
    expected: (await accountReview(scope)).hash,
    operation,
  };
  const preview = await previewReview(request);
  await executeReview({ ...request, effectExpected: preview.effectHash }, U);
}

describe.skipIf(process.env.DB_TESTS_SKIP === "1")(
  "PUE IVA collection dates against PostgreSQL",
  () => {
    beforeEach(async () => {
      await cleanup();
      actor = U;
      await prisma.user.createMany({
        data: [
          { id: U, email: "pue-owner@test.invalid" },
          { id: V, email: "pue-viewer@test.invalid" },
        ],
      });
      await prisma.company.createMany({
        data: [A, B].map((id, i) => ({
          id,
          rfc: `PUE26010${i}AA1`,
          razonSocial: id,
          regimenFiscal: "601",
          codigoPostal: "06600",
        })),
      });
      await prisma.companyMember.createMany({
        data: [
          { companyId: A, userId: U, role: "OWNER" },
          { companyId: A, userId: V, role: "VIEWER" },
        ],
      });
      await prisma.bankAccount.createMany({
        data: [A, B].map((id) => ({
          id: id + "-bank",
          companyId: id,
          banco: "Synthetic",
          nombre: "Test",
          numeroCuenta: "001",
        })),
      });
    });
    afterAll(cleanup);
    it("calculator, workpaper, CSV and ContaBot put a verified September receipt in September, once", async () => {
      const inv = await invoice();
      const tx = await movement(inv.id);
      await verifyStatement(tx);
      const september = await computeTaxPosition(A, 2026, 9),
        october = await computeTaxPosition(A, 2026, 10);
      expect(september.iva).toMatchObject({
        trasladado: 2000,
        pagar: 2000,
        actosGravados: 12500,
        cobrosPue: { determinado: true, importeDeterminado: 2000 },
      });
      expect(october.iva).toMatchObject({
        trasladado: 0,
        pagar: 0,
        actosGravados: 0,
        cobrosPue: { determinado: true },
      });
      const p9 = await (await workpaper(9)).json(),
        p10 = await (await workpaper(10)).json();
      expect(p9.totales.trasladado).toBe(2000);
      expect(p10.totales.trasladado).toBe(0);
      expect(p9.trasladado[0]).toMatchObject({
        fechaCfdi: "2026-10-01",
        fechasCobro: ["2026-09-30"],
        fuenteCobro: "BANCO_CONCILIADO",
      });
      const csv = await (await workpaper(9, "csv")).text();
      expect(csv).toContain("Fecha CFDI");
      expect(csv).toContain("2026-09-30");
      expect(csv).toContain("2026-10-01");
      const chat = JSON.parse(
        await executeToolCall(
          "query_tax_position",
          { year: 2026, month: 9 },
          A,
        ),
      );
      expect(chat.iva.trasladado).toBe(2000);
      expect(chat.iva.cobrosPue.determinado).toBe(true);
      expect((await declaration(9, 2000)).status).toBe(200);
      const api = await taxes(
        new Request(
          `http://test.local/api/impuestos?companyId=${A}&year=2026&month=9`,
        ),
      );
      expect((await api.json()).iva.cobrosPue).toMatchObject({
        determinado: true,
        importeDeterminado: 2000,
      });
      expect((await filing(9)).status).toBe(200);
      expect(
        await prisma.accountingEntry.count({ where: { companyId: A } }),
      ).toBe(0);
    });
    it("requires evidence for missing/provisional payments and reviewed classification for interest", async () => {
      const inv = await invoice({ interest: true });
      await movement(inv.id);
      expect(
        (await loadPueIncomeCollections(A, sep, oct)).summary,
      ).toMatchObject({
        determinado: false,
        importeDeterminado: null,
        trasladado: 2000,
      });
      expect((await declaration(9, 2000)).status).toBe(422);
      expect((await confirm(inv.id)).status).toBe(200);
      expect(
        (await loadPueIncomeCollections(A, sep, oct)).summary.determinado,
      ).toBe(true);
      expect(
        await prisma.auditLog.count({
          where: { companyId: A, accion: "factura.iva-cobro-revisado" },
        }),
      ).toBe(1);
      await prisma.bankTransaction.deleteMany({ where: { companyId: A } });
      expect((await computeTaxPosition(A, 2026, 9)).iva.trasladado).toBe(2000);
      expect((await computeTaxPosition(A, 2026, 10)).iva.trasladado).toBe(0);
    });
    it("never silently saves an invoice-month assumption when a receipt is missing", async () => {
      await invoice();
      const pos = await computeTaxPosition(A, 2026, 10);
      expect(pos.iva.cobrosPue).toMatchObject({
        determinado: false,
        importeDeterminado: null,
      });
      expect(pos.advertencias.join(" ")).toContain("preliminar");
      const chat = JSON.parse(
        await executeToolCall(
          "query_tax_position",
          { year: 2026, month: 10 },
          A,
        ),
      );
      expect(chat.instruccion_para_el_asistente).toContain(
        "NO está determinado",
      );
      expect((await declaration(10, 2000)).status).toBe(422);
      expect((await filing(10)).status).toBe(422);
      expect((await filing(10, { acuse: { ivaAPagar: 2000 } })).status).toBe(
        422,
      );
      expect(
        await prisma.taxDeclaration.count({ where: { companyId: A } }),
      ).toBe(0);
    });
    it("records complete actual filing figures without substituting an unconfirmed estimate", async () => {
      await invoice();
      expect(
        (
          await filing(10, {
            acuse: {
              ivaCausado: 2100,
              ivaAcreditable: 0,
              ivaAPagar: 2100,
              ivaAFavor: 0,
            },
          })
        ).status,
      ).toBe(200);
      const saved = await prisma.taxDeclaration.findFirst({
        where: { companyId: A, tipo: "IVA_MENSUAL" },
      });
      expect(saved).toMatchObject({
        status: "FILED",
        ivaTrasladadoCobrado: 2100,
        ivaPagar: 2100,
      });
      expect(
        (await computeTaxPosition(A, 2026, 10)).iva.cobrosPue.determinado,
      ).toBe(false);
    });
    it("invalidates determination after a verified bank source changes", async () => {
      const inv = await invoice(),
        tx = await movement(inv.id);
      await verifyStatement(tx);
      expect(
        (await loadPueIncomeCollections(A, sep, oct)).summary.determinado,
      ).toBe(true);
      await prisma.bankTransaction.update({
        where: { id: tx.id },
        data: { descripcion: "Changed source evidence" },
      });
      const result = await loadPueIncomeCollections(A, sep, oct);
      expect(result.summary).toMatchObject({
        determinado: false,
        importeDeterminado: null,
      });
      expect((await declaration(9, 2000)).status).toBe(422);
    });
    it("holds duplicates and special interest treatment even after a documentary review", async () => {
      const inv = await invoice({ interest: true });
      await movement(inv.id);
      await movement(inv.id);
      expect((await confirm(inv.id)).status).toBe(200);
      expect(
        (await loadPueIncomeCollections(A, sep, oct)).summary.determinado,
      ).toBe(false);
      expect((await filing(9)).status).toBe(422);
      await prisma.bankTransaction.deleteMany({ where: { companyId: A } });
      expect(
        (
          await confirm(inv.id, {
            tratamiento: "REVISION_ESPECIAL",
            fechaCobro: null,
            evidencia: null,
          })
        ).status,
      ).toBe(200);
      expect((await declaration(10, 2000)).status).toBe(422);
    });
    it("rejects a corrupt foreign-account link without exposing its financial evidence", async () => {
      const inv = await invoice(),
        tx = await movement(inv.id);
      await prisma.bankTransaction.update({
        where: { id: tx.id },
        data: {
          bankAccountId: B + "-bank",
          referencia: "FOREIGN PRIVATE REFERENCE",
        },
      });
      const result = await loadPueIncomeCollections(A, sep, oct);
      expect(result.summary.determinado).toBe(false);
      expect(JSON.stringify(result.summary)).not.toContain(
        "FOREIGN PRIVATE REFERENCE",
      );
    });
    it("deduplicates legacy + detailed pointers and applies one-to-many amounts without tenant leakage", async () => {
      const one = await invoice({ total: 7250, vat: 1000 }),
        two = await invoice({ total: 7250, vat: 1000 }),
        foreign = await invoice({ companyId: B });
      const tx = await movement(null);
      await prisma.conciliacionDetalle.createMany({
        data: [one, two].map((i) => ({
          bankTransactionId: tx.id,
          invoiceId: i.id,
          montoAsignado: 7250,
        })),
      });
      await confirm(one.id);
      await confirm(two.id);
      const summary = (await loadPueIncomeCollections(A, sep, oct)).summary;
      expect(summary.trasladado).toBe(2000);
      expect(summary.asignaciones.map((a) => a.invoiceId)).not.toContain(
        foreign.id,
      );
      await prisma.conciliacionDetalle.deleteMany({
        where: { bankTransactionId: tx.id },
      });
      await prisma.bankTransaction.update({
        where: { id: tx.id },
        data: { invoiceId: one.id, monto: 7250 },
      });
      await prisma.conciliacionDetalle.create({
        data: {
          bankTransactionId: tx.id,
          invoiceId: one.id,
          montoAsignado: 7250,
        },
      });
      expect(
        (await loadPueIncomeCollections(A, sep, oct)).summary.asignaciones.find(
          (a) => a.invoiceId === one.id,
        )?.trasladado,
      ).toBe(1000);
      await prisma.conciliacionDetalle.updateMany({
        where: { bankTransactionId: tx.id },
        data: { montoAsignado: 9000 },
      });
      expect(
        (await loadPueIncomeCollections(A, sep, oct)).summary.determinado,
      ).toBe(false);
    });
    it("rejects viewer, foreign-company, impossible-date and stale reviews without writes", async () => {
      const inv = await invoice(),
        other = await invoice({ companyId: B });
      actor = V;
      expect((await confirm(inv.id)).status).toBe(403);
      actor = U;
      expect((await confirm(other.id, { companyId: B })).status).toBe(403);
      expect((await confirm(inv.id, { fechaCobro: "2026-02-30" })).status).toBe(
        400,
      );
      expect((await confirm(inv.id, { expected: "0".repeat(64) })).status).toBe(
        409,
      );
      expect(await prisma.auditLog.count({ where: { companyId: A } })).toBe(0);
      expect((await confirm(inv.id)).status).toBe(200);
      const snapshot = await prisma.invoice.findUniqueOrThrow({
        where: { id: inv.id },
        include: pueInvoiceInclude,
      });
      const token = pueReviewToken(snapshot);
      expect(
        (
          await confirm(inv.id, {
            expected: token,
            motivo: "A newer documentary review retained",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await confirm(inv.id, {
            expected: token,
            motivo: "This stale review must not overwrite",
          })
        ).status,
      ).toBe(409);
      expect(
        await prisma.auditLog.count({
          where: { companyId: A, accion: "factura.iva-cobro-revisado" },
        }),
      ).toBe(2);
      await prisma.invoice.update({
        where: { id: inv.id },
        data: { total: 15000 },
      });
      expect(
        (await loadPueIncomeCollections(A, sep, oct)).summary.determinado,
      ).toBe(false);
    });
    it("preserves filed returns and closed ledgers and flags the affected prior period", async () => {
      const inv = await invoice();
      await confirm(inv.id);
      await prisma.taxDeclaration.create({
        data: {
          companyId: A,
          tipo: "IVA_MENSUAL",
          periodo: "2026-09",
          status: "FILED",
          ivaTrasladadoCobrado: 0,
          ivaPagar: 0,
        },
      });
      await prisma.accountingPeriod.create({
        data: { companyId: A, year: 2026, month: 9, status: "CLOSED" },
      });
      const pos = await computeTaxPosition(A, 2026, 9);
      expect(pos.iva.trasladado).toBe(2000);
      expect(pos.iva.cobrosPue.periodosARevisar).toContain("2026-09");
      expect((await declaration(9, 2000)).status).toBe(409);
      expect((await filing(9)).status).toBe(409);
      expect(
        await prisma.taxDeclaration.findFirst({ where: { companyId: A } }),
      ).toMatchObject({
        status: "FILED",
        ivaTrasladadoCobrado: 0,
        ivaPagar: 0,
      });
    });
    it("does not erase a collection when its invoice is cancelled or substituted", async () => {
      const inv = await invoice();
      await movement(inv.id);
      await confirm(inv.id);
      await prisma.invoice.update({
        where: { id: inv.id },
        data: { status: "CANCELLED" },
      });
      const result = await loadPueIncomeCollections(A, sep, oct);
      expect(result.summary.determinado).toBe(false);
      expect(result.summary.importeDeterminado).toBeNull();
      expect(result.summary.pendientes[0].motivos.join(" ")).toContain(
        "no vigente",
      );
    });
  },
);
