import { describe, it, expect } from "vitest";
import {
  TIPO_ASIENTO,
  asentarDeposito,
  asentarMovimientoKardex,
  cargoDeDevolucion,
  planMovimientoKardex,
  planesIvaDeposito,
} from "./asientos";
import { DbFalsa, comoDb } from "./__fixtures__/db-falsa";

// ─────────────────────────────────────────────────────────────────────────────
// Sólo la aplicación al paciente tocaba el libro: merma, caducidad, conteo y
// venta directa movían el kardex y 115.01 no bajaba. Y el depósito sin CFDI de
// anticipo causaba IVA (Art. 1-B LIVA) que nadie asentaba.
// ─────────────────────────────────────────────────────────────────────────────

const F = (iso: string) => new Date(iso);

function conCatalogo(activa = true, ivaAnticiposTasa: number | null = null) {
  const db = new DbFalsa().sembrar(["101.01", "105.01", "115.01", "501.01", "501.08", "704.23", "206.01", "208.01"]);
  db.configRow = { contabilidadActiva: activa, cuentasContables: null, ivaAnticiposTasa } as never;
  return db;
}

const mov = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  companyId: "c1",
  tipo: "MERMA" as const,
  cantidad: -4,
  costoUnitario: 25,
  fecha: F("2026-09-10T12:00:00Z"),
  asientoAt: null,
  descripcion: "Gasas · lote G-1",
  ...over,
});

describe("kardex que no es aplicación", () => {
  it("merma y caducidad: 501.08 contra inventario, al costo × cantidad", () => {
    expect(planMovimientoKardex(mov())).toMatchObject({ monto: 100, cargo: "MERMA_FARMACIA", abono: "INVENTARIO_FARMACIA", referenciaTipo: TIPO_ASIENTO.FARMACIA_MERMA });
    expect(planMovimientoKardex(mov({ tipo: "CADUCIDAD" }))).toMatchObject({ cargo: "MERMA_FARMACIA", abono: "INVENTARIO_FARMACIA" });
  });

  it("ajuste: faltante a 501.08, sobrante contra 704.23", () => {
    expect(planMovimientoKardex(mov({ tipo: "AJUSTE", cantidad: -2 }))).toMatchObject({ monto: 50, cargo: "MERMA_FARMACIA", abono: "INVENTARIO_FARMACIA" });
    expect(planMovimientoKardex(mov({ tipo: "AJUSTE", cantidad: 3 }))).toMatchObject({ monto: 75, cargo: "INVENTARIO_FARMACIA", abono: "SOBRANTE_INVENTARIO", referenciaTipo: TIPO_ASIENTO.FARMACIA_SOBRANTE });
  });

  it("devolución del paciente: reversa la aplicación sólo si llegó al libro, al costo de su tasa", () => {
    const dev = mov({ tipo: "DEVOLUCION", cantidad: 2, cargo: { ivaContexto: "SUMINISTRO_HOSPITALARIO", ivaTasa: 0.16 } });
    expect(planMovimientoKardex({ ...dev, origenAsentado: false })).toBeNull();
    expect(planMovimientoKardex({ ...dev, origenAsentado: true })).toMatchObject({ monto: 50, cargo: "INVENTARIO_FARMACIA", abono: "COSTO_FARMACIA_16" });
  });

  it("devolución al proveedor no se asienta aquí (la lleva su nota de crédito)", () => {
    expect(planMovimientoKardex(mov({ tipo: "DEVOLUCION", cantidad: -5, origenAsentado: true }))).toBeNull();
  });

  it("venta directa: costo 0 % contra inventario, salvo que su CFDI ampare cargos de un episodio (ya costeados)", () => {
    const venta = mov({ tipo: "SALIDA_VENTA", cantidad: -3 });
    expect(planMovimientoKardex({ ...venta, facturaConCargos: false })).toMatchObject({ monto: 75, cargo: "COSTO_FARMACIA_0", abono: "INVENTARIO_FARMACIA", referenciaTipo: TIPO_ASIENTO.FARMACIA_VENTA });
    expect(planMovimientoKardex({ ...venta, facturaConCargos: true })).toBeNull();
    expect(planMovimientoKardex(venta)).toBeNull(); // sin saberlo, no se arriesga el doble costo
  });

  it("entrada de compra y movimientos sin costo: nada", () => {
    expect(planMovimientoKardex(mov({ tipo: "ENTRADA_COMPRA", cantidad: 10 }))).toBeNull();
    expect(planMovimientoKardex(mov({ costoUnitario: null }))).toBeNull();
  });

  it("asienta una vez, sólo con la contabilidad activa", async () => {
    const db = conCatalogo();
    db.movimientos.push({ ...mov() });
    expect(await asentarMovimientoKardex(comoDb(db), mov())).toBe(1);
    expect(db.pares()).toMatchObject([{ cargo: "501.08", abono: "115.01", monto: 100 }]);
    expect(await asentarMovimientoKardex(comoDb(db), mov())).toBe(0);
    const apagada = conCatalogo(false);
    expect(await asentarMovimientoKardex(comoDb(apagada), mov())).toBe(0);
    expect(apagada.asientos).toHaveLength(0);
  });

  it("cargoDeDevolucion lee la referencia que escribe cancelarCargo", () => {
    expect(cargoDeDevolucion("Cancelación del cargo ck123: error de captura")).toBe("ck123");
    expect(cargoDeDevolucion("conteo")).toBeNull();
  });
});

const dep = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  companyId: "c1",
  fecha: F("2026-09-01T15:00:00Z"),
  monto: 11600,
  formaPago: "EFECTIVO" as const,
  estado: "RECIBIDO" as const,
  folio: "HOSP-1",
  ...over,
});

describe("IVA del depósito sin CFDI de anticipo", () => {
  it("sin tasa configurada o con CFDI de anticipo: no se parte", () => {
    expect(planesIvaDeposito(dep(), null)).toEqual([]);
    expect(planesIvaDeposito(dep(), 0)).toEqual([]);
    expect(planesIvaDeposito(dep({ invoiceAnticipoId: "inv1" }), 0.16)).toEqual([]);
  });

  it("recibido al 16 %: el IVA (1,600 de 11,600) pasa de 206.01 a 208.01", () => {
    const [p] = planesIvaDeposito(dep(), 0.16);
    expect(p).toMatchObject({ monto: 1600, cargo: "ANTICIPOS_PACIENTES", abono: "IVA_TRASLADADO_COBRADO", referenciaTipo: TIPO_ASIENTO.DEPOSITO_IVA });
  });

  it("aplicado a la cuenta: el IVA regresa al anticipo para que 206.01 cierre en cero", async () => {
    const db = conCatalogo(true, 0.16);
    db.depositos.push({ ...dep() });
    expect(await asentarDeposito(comoDb(db), dep())).toBe(2);
    const aplicado = dep({ estado: "APLICADO", aplicadoAt: F("2026-09-06T12:00:00Z") });
    expect(await asentarDeposito(comoDb(db), aplicado)).toBe(2);
    const tipos = db.pares().map((p) => p.referenciaTipo);
    expect(tipos).toEqual(["HOSP_DEPOSITO_RECIBIDO", "HOSP_DEPOSITO_IVA", "HOSP_DEPOSITO_APLICADO", "HOSP_DEPOSITO_IVA_REVERSA"]);
    // 206.01: +11,600 −1,600 −11,600 +1,600 = 0.
    const saldo206 = db.pares().reduce((s, p) => s + (p.abono === "206.01" ? p.monto : 0) - (p.cargo === "206.01" ? p.monto : 0), 0);
    expect(saldo206).toBe(0);
    expect(await asentarDeposito(comoDb(db), aplicado)).toBe(0);
  });

  it("cancelado sin IVA asentado: no reversa nada", () => {
    expect(planesIvaDeposito(dep({ estado: "CANCELADO" }), 0.16, { ivaRecibidoAsentado: false })).toEqual([]);
  });
});
