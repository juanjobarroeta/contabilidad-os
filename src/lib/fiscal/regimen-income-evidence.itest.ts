import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { readRegimenIncomeEvidence } from "./regimen-income-evidence";

const skip = process.env.DB_TESTS_SKIP === "1";
const parentUuid = "AAAAAAAA-1111-4111-8111-111111111111";
const pueUuid = "BBBBBBBB-2222-4222-8222-222222222222";
const split = [{ regimenCode: "606", basisPoints: 4000 }, { regimenCode: "612", basisPoints: 6000 }];

describe.skipIf(skip)("FISC-002M real PostgreSQL income snapshot", () => {
  let companyId: string;
  let pueId: string;
  let currentRepId: string;
  const companies: string[] = [];

  async function company() {
    const row = await prisma.company.create({ data: {
      rfc: `INCOME-ITEST-${randomUUID()}`, razonSocial: "Synthetic income evidence test", regimenFiscal: "612", codigoPostal: "06600",
      regimenes: { create: [
        { code: "606", label: "Arrendamiento", since: new Date("2026-01-01T00:00:00Z") },
        { code: "612", label: "Actividad empresarial", since: new Date("2026-01-01T00:00:00Z"), isPrimary: true },
      ] },
    } });
    companies.push(row.id);
    return row.id;
  }

  function invoice(scope: string, overrides: Partial<Prisma.InvoiceUncheckedCreateInput>) {
    return prisma.invoice.create({ data: {
      companyId: scope, tipo: "INGRESO", tipoSat: "I", status: "STAMPED", uuid: randomUUID().toUpperCase(),
      fecha: new Date("2026-08-15T12:00:00Z"), formaPago: "03", metodoPago: "PUE", usoCfdi: "G03", moneda: "MXN",
      subtotal: "100", descuento: "10", total: "104.4",
      regimenAssignment: { create: { revision: 2, reviewedById: "synthetic-reviewer", allocations: { create: split } } },
      ...overrides,
    } });
  }

  beforeEach(async () => {
    companyId = await company();
    await invoice(companyId, { uuid: parentUuid, fecha: new Date("2026-07-01T00:00:00Z"), metodoPago: "PPD", subtotal: "1000", descuento: "100", total: "1044" });
    pueId = (await invoice(companyId, { uuid: pueUuid })).id;
    for (const [index, amount] of ["261", "522", "261"].entries()) {
      const date = new Date(`2026-${String(index + 7).padStart(2, "0")}-15T12:00:00Z`);
      const rep = await invoice(companyId, {
        tipo: "PAGO", tipoSat: "P", fecha: date, subtotal: "0", descuento: "0", total: "0", regimenAssignment: undefined,
        doctosRelacionados: { create: { parentUuid, impPagado: amount, numParcialidad: index + 1, fechaPago: date } },
      });
      if (index === 1) currentRepId = rep.id;
    }
  });

  afterEach(async () => {
    await prisma.invoice.deleteMany({ where: { companyId: { in: companies } } });
    await prisma.company.deleteMany({ where: { id: { in: companies } } });
    companies.length = 0;
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it("reads reviewed PUE and cumulative REP bases from the actual schema", async () => {
    const result = await readRegimenIncomeEvidence(companyId, 2026, 8);
    expect(result).toMatchObject({
      estado: "PROYECTABLE", usadaEnCalculoAutomatico: false, pueAcreditaCobro: false,
      totales: { pueDocumentadoCentavos: 9000, ppdRepCentavos: 45000 }, pendientes: [],
      porRegimen: [
        { regimenCode: "606", pueDocumentadoCentavos: 3600, ppdRepCentavos: 18000 },
        { regimenCode: "612", pueDocumentadoCentavos: 5400, ppdRepCentavos: 27000 },
      ],
    });
    expect(result?.renglones.map((row) => row.assignmentRevision)).toEqual([2, 2]);
  });

  it("does not absorb matching UUIDs or payments owned by another company", async () => {
    const other = await company();
    await invoice(other, { uuid: parentUuid, metodoPago: "PPD", subtotal: "500000", total: "580000" });
    await invoice(other, { uuid: pueUuid, subtotal: "500000", total: "580000" });
    await invoice(other, {
      tipo: "PAGO", tipoSat: "P", regimenAssignment: undefined,
      doctosRelacionados: { create: { parentUuid, impPagado: "500000", numParcialidad: 2, fechaPago: new Date("2026-08-15T12:00:00Z") } },
    });
    expect((await readRegimenIncomeEvidence(companyId, 2026, 8))?.totales)
      .toEqual({ pueDocumentadoCentavos: 9000, ppdRepCentavos: 45000 });
  });

  it("excludes cancelled and superseded REP from both current and historical scans", async () => {
    const replacementUuid = randomUUID().toUpperCase();
    await prisma.invoice.update({ where: { id: currentRepId }, data: { sustituidoPorUuid: replacementUuid } });
    for (const status of ["STAMPED", "CANCELLED"] as const) {
      await invoice(companyId, {
        tipo: "PAGO", tipoSat: "P", status, uuid: status === "STAMPED" ? replacementUuid : randomUUID(), regimenAssignment: undefined,
        doctosRelacionados: { create: { parentUuid, impPagado: "522", numParcialidad: 2, fechaPago: new Date("2026-08-15T12:00:00Z") } },
      });
    }
    expect((await readRegimenIncomeEvidence(companyId, 2026, 8))?.totales)
      .toEqual({ pueDocumentadoCentavos: 9000, ppdRepCentavos: 45000 });
  });

  it("keeps undated REP pending instead of omitting their unknown period", async () => {
    await prisma.pagoDoctoRelacionado.updateMany({ where: { pagoInvoiceId: currentRepId }, data: { fechaPago: null } });
    const result = await readRegimenIncomeEvidence(companyId, 2026, 8);
    expect(result).toMatchObject({ estado: "PENDIENTE", totales: null, porRegimen: null });
    expect(result?.pendientes).toContainEqual(expect.objectContaining({ code: "PAYMENT_DATE_UNAVAILABLE" }));
  });

  it("preserves the sixth decimal before rounding near a large half-cent boundary", async () => {
    await prisma.invoice.update({ where: { id: pueId }, data: { subtotal: "8589934592.004999", descuento: "0", total: "8589934592.004999" } });
    expect((await readRegimenIncomeEvidence(companyId, 2026, 8))?.totales)
      .toEqual({ pueDocumentadoCentavos: 858993459200, ppdRepCentavos: 45000 });
  });

  it("does not hide an undated payment merely because its REP was issued later", async () => {
    await prisma.invoice.update({ where: { id: currentRepId }, data: { fecha: new Date("2026-09-20T00:00:00Z") } });
    await prisma.pagoDoctoRelacionado.updateMany({ where: { pagoInvoiceId: currentRepId }, data: { fechaPago: null } });
    const result = await readRegimenIncomeEvidence(companyId, 2026, 8);
    expect(result?.totales).toBeNull();
    expect(result?.pendientes).toContainEqual(expect.objectContaining({ code: "PAYMENT_DATE_UNAVAILABLE" }));
  });

  it("rejects a stored amount outside the safe integer-micros range", async () => {
    await prisma.invoice.update({ where: { id: pueId }, data: { subtotal: "9007199254.740992", total: "9007199254.740992" } });
    const result = await readRegimenIncomeEvidence(companyId, 2026, 8);
    expect(result?.totales).toBeNull();
    expect(result?.pendientes).toContainEqual({ id: pueId, code: "INVALID_INVOICE_AMOUNTS" });
  });

  it("blocks a linked credit note even when it was issued in another month", async () => {
    const note = await invoice(companyId, { tipoSat: "E", fecha: new Date("2026-09-01T00:00:00Z"), cfdiRelacionadoUuid: parentUuid });
    const result = await readRegimenIncomeEvidence(companyId, 2026, 8);
    expect(result?.totales).toBeNull();
    expect(result?.pendientes).toContainEqual({ id: note.id, code: "CREDIT_NOTE_REVIEW" });
  });

  it("detects UUID case aliases outside the PUE emission month", async () => {
    await invoice(companyId, { uuid: pueUuid.toLowerCase(), fecha: new Date("2026-07-15T12:00:00Z") });
    const result = await readRegimenIncomeEvidence(companyId, 2026, 8);
    expect(result?.totales).toBeNull();
    expect(result?.pendientes).toContainEqual({ id: pueId, code: "AMBIGUOUS_INVOICE_UUID" });
  });

  it("returns absent company evidence as absent, not as a zero summary", async () => {
    expect(await readRegimenIncomeEvidence(`missing-${randomUUID()}`, 2026, 8)).toBeNull();
  });
});
