import { describe, it, expect } from "vitest";
import { hashBalanza, decidirEnvio } from "./coe-envio";
import type { BalanzaCuentaInput } from "./coe-xml";

const rows: BalanzaCuentaInput[] = [
  { numCta: "102.01", cargos: 300, abonos: 100, saldoInicial: 1000, saldoFinal: 1200 },
  { numCta: "201.01", cargos: 0, abonos: 500, saldoInicial: -2000, saldoFinal: -2500 },
];

describe("hashBalanza", () => {
  it("es estable e independiente del orden de las cuentas", () => {
    expect(hashBalanza(rows)).toBe(hashBalanza([rows[1], rows[0]]));
  });
  it("cambia cuando cambia un importe", () => {
    const otra = [{ ...rows[0], cargos: 301 }, rows[1]];
    expect(hashBalanza(otra)).not.toBe(hashBalanza(rows));
  });
  it("ignora cuentas vacías (no afectan el hash)", () => {
    const conVacia = [...rows, { numCta: "107.01", cargos: 0, abonos: 0, saldoInicial: 0, saldoFinal: 0 }];
    expect(hashBalanza(conVacia)).toBe(hashBalanza(rows));
  });
});

describe("decidirEnvio (N vs C)", () => {
  it("sin envío previo → Normal", () => {
    expect(decidirEnvio(null, "abc", "2026-06-14")).toEqual({ tipoEnvio: "N", fechaModBal: null });
  });
  it("mismo contenido que el previo → se mantiene (re-descarga, no complementaria)", () => {
    const prev = { contenidoHash: "abc", tipoEnvio: "N", fechaModBal: null };
    expect(decidirEnvio(prev, "abc", "2026-06-14")).toEqual({ tipoEnvio: "N", fechaModBal: null });
  });
  it("contenido distinto al previo → Complementaria con FechaModBal = hoy", () => {
    const prev = { contenidoHash: "abc", tipoEnvio: "N", fechaModBal: null };
    expect(decidirEnvio(prev, "xyz", "2026-06-14")).toEqual({ tipoEnvio: "C", fechaModBal: "2026-06-14" });
  });
});
