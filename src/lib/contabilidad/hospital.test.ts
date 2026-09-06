import { describe, it, expect } from "vitest";
import {
  SIN_HOSPITAL,
  agruparCargosPorClave,
  cargarContextoHospital,
  piernasIngresoHospital,
  piernasResultadosHospital,
  repartirHospital,
  type ContextoHospital,
} from "./hospital";
import type { ClaveMotor } from "../hospital/contabilidad";
import type { CuentaTaller } from "./taller";
import { DbFalsa, comoDb } from "../hospital/__fixtures__/db-falsa";

const cta = (id: string, codigo: string, tipo = "INGRESO"): CuentaTaller => ({ id, cuentaSAT: codigo.slice(0, 3), subcuenta: codigo, nombre: codigo, tipo });

const CUENTAS = new Map<ClaveMotor, CuentaTaller>([
  ["INGRESO_HOSPITALIZACION", cta("hosp", "401.01")],
  ["INGRESO_QUIROFANO", cta("quir", "401.01")],
  ["INGRESO_ESTUDIOS", cta("estu", "401.01")],
  ["INGRESO_FARMACIA_16", cta("far16", "401.01")],
  ["INGRESO_FARMACIA_0", cta("far0", "401.04")],
  ["HONORARIOS_POR_CUENTA_DE_TERCEROS", cta("hono", "205.06", "PASIVO")],
]);

const suma = (piernas: Array<{ monto: number }>) => Math.round(piernas.reduce((s, p) => s + p.monto, 0) * 100) / 100;

describe("agruparCargosPorClave()", () => {
  it("agrupa por CFDI y clave; ignora cancelados y sin CFDI", () => {
    const m = agruparCargosPorClave([
      { invoiceId: "f1", categoria: "HABITACION", importe: 3200 },
      { invoiceId: "f1", categoria: "HABITACION", importe: 3200 },
      { invoiceId: "f1", categoria: "FARMACIA", ivaContexto: "SUMINISTRO_HOSPITALARIO", importe: 510 },
      { invoiceId: "f1", categoria: "FARMACIA", ivaContexto: "VENTA_DIRECTA", importe: 214 },
      { invoiceId: "f1", categoria: "HONORARIO", importe: 18000 },
      { invoiceId: "f1", categoria: "QUIROFANO", importe: 999, cancelado: true },
      { invoiceId: null, categoria: "QUIROFANO", importe: 12000 },
      { invoiceId: "f2", categoria: "ESTUDIO", importe: 680 },
    ]);
    expect([...m.get("f1")!.entries()]).toEqual([
      ["INGRESO_HOSPITALIZACION", 6400],
      ["INGRESO_FARMACIA_16", 510],
      ["INGRESO_FARMACIA_0", 214],
      ["HONORARIOS_POR_CUENTA_DE_TERCEROS", 18000],
    ]);
    expect([...m.get("f2")!.entries()]).toEqual([["INGRESO_ESTUDIOS", 680]]);
  });
});

describe("repartirHospital()", () => {
  it("las piernas suman el subtotal exacto y el honorario va al pasivo", () => {
    const porClave = new Map<ClaveMotor, number>([
      ["INGRESO_HOSPITALIZACION", 6400],
      ["INGRESO_QUIROFANO", 12000],
      ["HONORARIOS_POR_CUENTA_DE_TERCEROS", 18000],
    ]);
    const piernas = repartirHospital(36400, porClave, CUENTAS)!;
    expect(piernas.map((p) => [p.clave, p.cuenta.id, p.monto])).toEqual([
      ["INGRESO_HOSPITALIZACION", "hosp", 6400],
      ["INGRESO_QUIROFANO", "quir", 12000],
      ["HONORARIOS_POR_CUENTA_DE_TERCEROS", "hono", 18000],
    ]);
    expect(suma(piernas)).toBe(36400);
  });

  it("los cargos son proporción: escala al subtotal del CFDI", () => {
    const porClave = new Map<ClaveMotor, number>([
      ["INGRESO_HOSPITALIZACION", 500],
      ["INGRESO_QUIROFANO", 500],
    ]);
    expect(repartirHospital(3000, porClave, CUENTAS)!.map((p) => p.monto)).toEqual([1500, 1500]);
  });

  it("el residuo de redondeo lo absorbe la pierna mayor", () => {
    const porClave = new Map<ClaveMotor, number>([
      ["INGRESO_HOSPITALIZACION", 1],
      ["INGRESO_QUIROFANO", 1],
      ["INGRESO_ESTUDIOS", 1],
    ]);
    // 100 / 3 = 33.33 × 3 = 99.99 → un centavo a alguna (todas iguales: la primera).
    const p1 = repartirHospital(100, porClave, CUENTAS)!;
    expect(p1.map((p) => p.monto)).toEqual([33.34, 33.33, 33.33]);
    expect(suma(p1)).toBe(100);

    const desigual = new Map<ClaveMotor, number>([
      ["INGRESO_HOSPITALIZACION", 1],
      ["INGRESO_QUIROFANO", 5],
      ["INGRESO_ESTUDIOS", 1],
    ]);
    const p2 = repartirHospital(1000.01, desigual, CUENTAS)!;
    expect(suma(p2)).toBe(1000.01);
    expect(p2[1].monto).toBeGreaterThan(p2[0].monto);
    // Al azar, muchos subtotales: siempre exacto.
    for (let i = 1; i < 200; i++) {
      const sub = Math.round(i * 137.37 * 100) / 100;
      expect(suma(repartirHospital(sub, desigual, CUENTAS)!)).toBe(sub);
    }
  });

  it("null cuando no hay cargos, el subtotal es cero o falta la cuenta de una clave", () => {
    expect(repartirHospital(100, undefined, CUENTAS)).toBeNull();
    expect(repartirHospital(100, new Map(), CUENTAS)).toBeNull();
    expect(repartirHospital(0, new Map([["INGRESO_QUIROFANO", 10]]), CUENTAS)).toBeNull();
    expect(repartirHospital(100, new Map([["INGRESO_OTROS", 10]]), CUENTAS)).toBeNull();
  });

  it("nota de crédito (subtotal negativo en el motor) reparte con el mismo signo", () => {
    const piernas = repartirHospital(-300, new Map([["INGRESO_QUIROFANO", 2], ["INGRESO_ESTUDIOS", 1]]), CUENTAS)!;
    expect(piernas.map((p) => p.monto)).toEqual([-200, -100]);
  });
});

describe("piernasResultadosHospital()", () => {
  const ctx: ContextoHospital = {
    activa: true,
    cargos: new Map([
      ["f1", new Map<ClaveMotor, number>([["INGRESO_QUIROFANO", 1000], ["HONORARIOS_POR_CUENTA_DE_TERCEROS", 500]])],
      ["f2", new Map<ClaveMotor, number>([["HONORARIOS_POR_CUENTA_DE_TERCEROS", 500]])],
    ]),
    cuentas: CUENTAS,
  };

  it("quita la pierna del pasivo; un CFDI puro honorario devuelve [] y no null", () => {
    expect(piernasIngresoHospital("f1", 1500, ctx)!.map((p) => p.monto)).toEqual([1000, 500]);
    expect(piernasResultadosHospital("f1", 1500, ctx)!.map((p) => [p.clave, p.monto])).toEqual([["INGRESO_QUIROFANO", 1000]]);
    expect(piernasResultadosHospital("f2", 500, ctx)).toEqual([]);
    expect(piernasResultadosHospital("f9", 500, ctx)).toBeNull();
  });
});

describe("cargarContextoHospital()", () => {
  const armar = (activa: boolean) => {
    const db = new DbFalsa().sembrar(["401.01"]);
    db.configRow = { contabilidadActiva: activa, cuentasContables: null };
    db.cargos.push(
      { id: "k1", companyId: "c1", episodioId: "e1", invoiceId: "f1", categoria: "HABITACION", ivaContexto: null, ivaTasa: 0.16, importe: 3200, cancelado: false },
      { id: "k2", companyId: "c1", episodioId: "e1", invoiceId: "f1", categoria: "HONORARIO", ivaContexto: null, ivaTasa: null, importe: 8000, cancelado: false },
      { id: "k3", companyId: "c1", episodioId: "e1", invoiceId: "f1", categoria: "ESTUDIO", ivaContexto: null, ivaTasa: 0.16, importe: 1, cancelado: true }
    );
    return db;
  };

  it("apagada → contexto vacío y el motor no cambia de conducta", async () => {
    const db = armar(false);
    const ctx = await cargarContextoHospital("c1", ["f1"], { db: comoDb(db) });
    expect(ctx).toBe(SIN_HOSPITAL);
    expect(piernasIngresoHospital("f1", 11200, ctx)).toBeNull();
    expect(db.cuentaPorCodigo("205.06")).toBeNull();
  });

  it("apagada pero con incluirInactiva (previsualización) sí parte", async () => {
    const ctx = await cargarContextoHospital("c1", ["f1"], { db: comoDb(armar(false)), incluirInactiva: true });
    expect(ctx.activa).toBe(false);
    expect(piernasIngresoHospital("f1", 11200, ctx)!.map((p) => [p.clave, p.monto])).toEqual([
      ["INGRESO_HOSPITALIZACION", 3200],
      ["HONORARIOS_POR_CUENTA_DE_TERCEROS", 8000],
    ]);
  });

  it("activa: resuelve (y crea) las cuentas de las claves usadas", async () => {
    const db = armar(true);
    const ctx = await cargarContextoHospital("c1", ["f1", "f-sin-cargos"], { db: comoDb(db) });
    expect(ctx.activa).toBe(true);
    expect([...ctx.cuentas.keys()].sort()).toEqual(["HONORARIOS_POR_CUENTA_DE_TERCEROS", "INGRESO_HOSPITALIZACION"]);
    expect(ctx.cuentas.get("HONORARIOS_POR_CUENTA_DE_TERCEROS")).toMatchObject({ cuentaSAT: "205", subcuenta: "205.06", tipo: "PASIVO" });
    expect(db.cuentaPorCodigo("205.06")).not.toBeNull();
    const piernas = piernasIngresoHospital("f1", 11200, ctx)!;
    expect(suma(piernas)).toBe(11200);
    expect(piernasIngresoHospital("f-sin-cargos", 500, ctx)).toBeNull();
  });

  it("sin CFDIs no consulta nada", async () => {
    expect(await cargarContextoHospital("c1", [], { db: comoDb(new DbFalsa()) })).toBe(SIN_HOSPITAL);
  });
});
