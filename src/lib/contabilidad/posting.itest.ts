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

describe.skipIf(skip)("postMonth contra Postgres real", () => {
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
  });

  afterAll(async () => {
    await limpiar();
    await prisma.$disconnect();
  });

  describe("banco multi-cuenta (agosto 2026)", () => {
  beforeAll(async () => {
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

  it("un IGNORED sin categoría bloquea el cierre con mensaje accionable", async () => {
    // Plural real: "1 ignorado sin categoría" / "2 ignorados sin categoría".
    await expect(postMonth({ companyId: CIA, year: 2026, month: 8 })).rejects.toThrow(
      /ignorados? sin categoría/
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

  // ─── Ola C: IVA al flujo contra Postgres real ─────────────────────────────
  describe("reclasificación de IVA al flujo (sept 2026)", () => {
  const MES = 9;

  beforeAll(async () => {
    // Facturas de septiembre + su liquidación bancaria.
    await prisma.invoice.createMany({
      data: [
        // Ingreso IVA 16%, cobrada COMPLETA
        {
          id: "pc-ing1", companyId: CIA, fecha: new Date("2026-09-03T12:00:00Z"),
          tipo: "INGRESO", status: "STAMPED", uuid: "pc-uuid-ing1",
          formaPago: "03", metodoPago: "PUE", usoCfdi: "G03",
          subtotal: 1000, total: 1160, updatedAt: new Date(),
        },
        // Ingreso IVA 16%, cobrada a la MITAD vía detalle
        {
          id: "pc-ing2", companyId: CIA, fecha: new Date("2026-09-05T12:00:00Z"),
          tipo: "INGRESO", status: "STAMPED", uuid: "pc-uuid-ing2",
          formaPago: "03", metodoPago: "PPD", usoCfdi: "G03",
          subtotal: 2000, total: 2320, updatedAt: new Date(),
        },
        // Egreso IVA 16%, pagado completo
        {
          id: "pc-egr1", companyId: CIA, fecha: new Date("2026-09-07T12:00:00Z"),
          tipo: "EGRESO", status: "STAMPED", uuid: "pc-uuid-egr1",
          formaPago: "03", metodoPago: "PUE", usoCfdi: "G03",
          subtotal: 500, total: 580, updatedAt: new Date(),
        },
        // LEGADA: emitida en julio (fuera del mes posteado) — su devengo nunca
        // pasó por 209, así que su cobro NO debe reclasificar.
        {
          id: "pc-leg", companyId: CIA, fecha: new Date("2026-07-10T12:00:00Z"),
          tipo: "INGRESO", status: "STAMPED", uuid: "pc-uuid-leg",
          formaPago: "03", metodoPago: "PPD", usoCfdi: "G03",
          subtotal: 3000, total: 3480, updatedAt: new Date(),
        },
      ],
    });
    await prisma.bankTransaction.createMany({
      data: [
        { id: "pc-cob1", companyId: CIA, bankAccountId: "pb-x", fecha: new Date("2026-09-10T12:00:00Z"), descripcion: "Cobro ing1", tipo: "CREDITO", monto: 1160, status: "MATCHED", invoiceId: "pc-ing1" },
        { id: "pc-cob2", companyId: CIA, bankAccountId: "pb-x", fecha: new Date("2026-09-12T12:00:00Z"), descripcion: "Abono parcial ing2", tipo: "CREDITO", monto: 1160, status: "MATCHED" },
        { id: "pc-pago", companyId: CIA, bankAccountId: "pb-y", fecha: new Date("2026-09-15T12:00:00Z"), descripcion: "Pago egr1", tipo: "DEBITO", monto: -580, status: "MATCHED", invoiceId: "pc-egr1" },
        { id: "pc-cobleg", companyId: CIA, bankAccountId: "pb-x", fecha: new Date("2026-09-20T12:00:00Z"), descripcion: "Cobro legada", tipo: "CREDITO", monto: 3480, status: "MATCHED", invoiceId: "pc-leg" },
      ],
    });
    await prisma.conciliacionDetalle.create({
      data: { bankTransactionId: "pc-cob2", invoiceId: "pc-ing2", montoAsignado: 1160 },
    });
  });

  it("devengo a pendientes, reclasificación proporcional y legada intacta", async () => {
    await postMonth({ companyId: CIA, year: 2026, month: MES });

    const cuentas = await prisma.chartAccount.findMany({
      where: { companyId: CIA, subcuenta: { in: ["208.01", "209.01", "118.01", "119.01"] } },
      select: { id: true, subcuenta: true },
    });
    const idPor = new Map(cuentas.map((c) => [c.subcuenta, c.id]));
    const saldo = async (sub: string, natur: "D" | "A") => {
      const rows = await prisma.accountingEntry.findMany({
        where: { companyId: CIA, year: 2026, month: MES, chartAccountId: idPor.get(sub)! },
        select: { tipo: true, monto: true },
      });
      const d = rows.filter((r) => r.tipo === "CARGO").reduce((s, r) => s + Number(r.monto), 0);
      const a = rows.filter((r) => r.tipo === "ABONO").reduce((s, r) => s + Number(r.monto), 0);
      return natur === "A" ? a - d : d - a;
    };

    // 209 (pendiente, acreedora): devengó 160+320 y reclasificó 160+160 → queda 160
    expect(await saldo("209.01", "A")).toBeCloseTo(160, 2);
    // 208 (cobrado): completa 160 + mitad de ing2 160 = 320. La LEGADA no suma.
    expect(await saldo("208.01", "A")).toBeCloseTo(320, 2);
    // 119 (acreditable pendiente, deudora): devengó 80, pagó 80 → 0
    expect(await saldo("119.01", "D")).toBeCloseTo(0, 2);
    // 118 (acreditable pagado): 80
    expect(await saldo("118.01", "D")).toBeCloseTo(80, 2);

    // La legada liquidó Clientes pero NO tocó 208/209.
    const legada = await prisma.accountingEntry.findMany({
      where: { companyId: CIA, referencia: "pc-cobleg" },
      select: { chartAccountId: true },
    });
    expect(legada.length).toBe(2); // sólo DR banco / AB clientes
    for (const e of legada) {
      expect([idPor.get("208.01"), idPor.get("209.01")]).not.toContain(e.chartAccountId);
    }
  });

  it("re-posteo idempotente: mismos saldos de IVA", async () => {
    await postMonth({ companyId: CIA, year: 2026, month: MES });
    const c209 = await prisma.accountingEntry.count({
      where: {
        companyId: CIA, year: 2026, month: MES,
        chartAccount: { subcuenta: "209.01" },
      },
    });
    // devengo ing1 + ing2 (2 abonos) + reclas ing1 + ing2 (2 cargos) = 4
    expect(c209).toBe(4);
  });
});
});
