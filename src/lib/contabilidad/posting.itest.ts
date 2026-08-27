import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../prisma";
import { postMonth } from "./posting";
import { seedChartOfAccounts } from "./seed-catalog";

// ─────────────────────────────────────────────────────────────────────────────
// Primer itest del motor de posteo contra Postgres real (CE confiable, Ola B).
// Cubre el camino DB que posting.test.ts declara "se verifica a mano":
//   · subcuenta contable por cuenta bancaria (2 cuentas → 102.01.01/.02)
//   · traspaso interno X→Y: UNA póliza cruzada (el depósito espejo no duplica)
//   · enteramiento de impuestos conciliado: DR Impuestos / AB subcuenta
//   · IGNORED sin categoría BLOQUEA el cierre (misma disciplina que UNMATCHED)
// ─────────────────────────────────────────────────────────────────────────────

const skip = process.env.DB_TESTS_SKIP === "1";

const CIA = "pb-cia";
const CLABE_X = "012180001111111111";
const CLABE_Y = "014180002222222222";

async function limpiar() {
  await prisma.accountingEntry.deleteMany({ where: { companyId: CIA } });
  await prisma.accountingPeriod.deleteMany({ where: { companyId: CIA } });
  await prisma.bankTransaction.deleteMany({ where: { companyId: CIA } });
  await prisma.taxDeclaration.deleteMany({ where: { companyId: CIA } });
  await prisma.invoice.deleteMany({ where: { companyId: CIA } });
  await prisma.bankAccount.deleteMany({ where: { companyId: CIA } });
  await prisma.chartAccount.deleteMany({ where: { companyId: CIA } });
  await prisma.company.deleteMany({ where: { id: CIA } });
}

describe.skipIf(skip)("postMonth contra Postgres real — banco multi-cuenta", () => {
  beforeAll(async () => {
    await limpiar();
    await prisma.company.create({
      data: {
        id: CIA,
        rfc: "PBI010101AAA",
        razonSocial: "Posting Banco iTest",
        regimenFiscal: "601",
        codigoPostal: "06600",
      },
    });
    await seedChartOfAccounts(CIA);
    await prisma.bankAccount.createMany({
      data: [
        { id: "pb-x", companyId: CIA, banco: "BBVA", nombre: "Operativa", numeroCuenta: "1111", clabe: CLABE_X },
        { id: "pb-y", companyId: CIA, banco: "Santander", nombre: "Nómina", numeroCuenta: "2222", clabe: CLABE_Y },
      ],
    });
    await prisma.taxDeclaration.create({
      data: { id: "pb-td", companyId: CIA, tipo: "IVA_MENSUAL", periodo: "2026-07" },
    });
    // Movimientos de agosto 2026 (sin CFDIs del periodo: aislamos el banco).
    await prisma.bankTransaction.createMany({
      data: [
        // enteramiento de impuestos (salida en X, MATCHED ↔ TaxDeclaration)
        {
          id: "pb-tax", companyId: CIA, bankAccountId: "pb-x",
          fecha: new Date("2026-08-17T12:00:00Z"), descripcion: "SAT linea captura",
          tipo: "DEBITO", monto: -3500, status: "MATCHED", taxDeclarationId: "pb-td",
        },
        // traspaso X→Y: retiro + depósito espejo
        {
          id: "pb-out", companyId: CIA, bankAccountId: "pb-x",
          fecha: new Date("2026-08-10T12:00:00Z"), descripcion: "Traspaso a nomina",
          tipo: "DEBITO", monto: -10000, status: "IGNORED", notes: "INTERNAL_TRANSFER",
          contraparteClabe: CLABE_Y,
        },
        {
          id: "pb-in", companyId: CIA, bankAccountId: "pb-y",
          fecha: new Date("2026-08-10T12:05:00Z"), descripcion: "Deposito desde operativa",
          tipo: "CREDITO", monto: 10000, status: "IGNORED", notes: "INTERNAL_TRANSFER",
          contraparteClabe: CLABE_X,
        },
        // comisión con tag válido (control)
        {
          id: "pb-fee", companyId: CIA, bankAccountId: "pb-y",
          fecha: new Date("2026-08-20T12:00:00Z"), descripcion: "Comision manejo",
          tipo: "DEBITO", monto: -250, status: "IGNORED", notes: "PENDING_MONTHLY_CFDI",
        },
        // ignorado SIN categoría: debe bloquear
        {
          id: "pb-raro", companyId: CIA, bankAccountId: "pb-x",
          fecha: new Date("2026-08-22T12:00:00Z"), descripcion: "Cargo raro",
          tipo: "DEBITO", monto: -99, status: "IGNORED", notes: null,
        },
      ],
    });
  });

  afterAll(async () => {
    await limpiar();
    await prisma.$disconnect();
  });

  it("un IGNORED sin categoría bloquea el cierre con mensaje accionable", async () => {
    await expect(postMonth({ companyId: CIA, year: 2026, month: 8 })).rejects.toThrow(
      /ignorado\(s\) sin categoría/
    );
  });

  it("categorizado todo: postea con subcuentas, traspaso cruzado único y enteramiento", async () => {
    await prisma.bankTransaction.update({
      where: { id: "pb-raro" },
      data: { notes: "NON_DEDUCTIBLE" },
    });

    const res = await postMonth({ companyId: CIA, year: 2026, month: 8 });
    expect(res.totalCargos).toBeCloseTo(res.totalAbonos, 2);

    // Subcuentas creadas y ligadas a cada cuenta bancaria.
    const cuentas = await prisma.bankAccount.findMany({
      where: { companyId: CIA },
      select: { id: true, chartAccount: { select: { subcuenta: true, nombre: true, codAgrup: true, nivel: true } } },
      orderBy: { id: "asc" },
    });
    const subX = cuentas.find((c) => c.id === "pb-x")!.chartAccount!;
    const subY = cuentas.find((c) => c.id === "pb-y")!.chartAccount!;
    expect(subX.subcuenta).toMatch(/^102\.01\.\d{2}$/);
    expect(subY.subcuenta).toMatch(/^102\.01\.\d{2}$/);
    expect(subX.subcuenta).not.toBe(subY.subcuenta);
    expect(subX.codAgrup).toBe("102.01"); // el hijo hereda el agrupador REAL
    expect(subX.nombre).toContain("BBVA");

    const entries = await prisma.accountingEntry.findMany({
      where: { companyId: CIA, year: 2026, month: 8 },
      select: { referencia: true, tipo: true, monto: true, chartAccount: { select: { subcuenta: true, nombre: true } } },
    });

    // Traspaso: UNA póliza cruzada (2 asientos, del retiro), el espejo cubierto.
    const traspaso = entries.filter((e) => e.referencia === "pb-out");
    expect(traspaso).toHaveLength(2);
    const cargo = traspaso.find((e) => e.tipo === "CARGO")!;
    const abono = traspaso.find((e) => e.tipo === "ABONO")!;
    expect(cargo.chartAccount.subcuenta).toBe(subY.subcuenta); // entra a Nómina
    expect(abono.chartAccount.subcuenta).toBe(subX.subcuenta); // sale de Operativa
    expect(entries.filter((e) => e.referencia === "pb-in")).toHaveLength(0); // espejo NO duplica

    // Enteramiento: DR Impuestos y derechos / AB subcuenta de X.
    const tax = entries.filter((e) => e.referencia === "pb-tax");
    expect(tax).toHaveLength(2);
    expect(tax.find((e) => e.tipo === "CARGO")!.chartAccount.nombre).toMatch(/impuestos/i);
    expect(tax.find((e) => e.tipo === "ABONO")!.chartAccount.subcuenta).toBe(subX.subcuenta);

    // Comisión: AB en la subcuenta de Y (no en la base).
    const fee = entries.filter((e) => e.referencia === "pb-fee");
    expect(fee.find((e) => e.tipo === "ABONO")!.chartAccount.subcuenta).toBe(subY.subcuenta);
  });

  it("re-posteo: mismas subcuentas (ligadas, no re-creadas) y sin duplicar", async () => {
    const antes = await prisma.chartAccount.count({ where: { companyId: CIA } });
    await postMonth({ companyId: CIA, year: 2026, month: 8 });
    expect(await prisma.chartAccount.count({ where: { companyId: CIA } })).toBe(antes);
    const traspaso = await prisma.accountingEntry.count({
      where: { companyId: CIA, referencia: "pb-out" },
    });
    expect(traspaso).toBe(2);
  });
});
