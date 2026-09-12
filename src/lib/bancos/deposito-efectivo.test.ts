import { describe, expect, it } from "vitest";
import { esDepositoEnEfectivo } from "./deposito-efectivo";

describe("esDepositoEnEfectivo", () => {
  // Todas salieron de estados de cuenta reales.
  it.each([
    "DEPOSITO EN EFECTIVO",
    "DEPOSITO EN EFECTIVO/0012345678",
    "C02 DEPOSITO EN EFECTIVO",
    "DEPOSITO EN EFECTIVO ATM",
    "DEPOSITO EFECTIVO PRACTIC",
    "DEPOSITO EFECTIVO SUC 0123",
    "DEP.EFECTIVO",
    "Deposito en Efectivo por 1234.40 mxn | Recibo",
    "DEPÓSITO EN EFECTIVO",
  ])("reconoce «%s»", (d) => {
    expect(esDepositoEnEfectivo(d)).toBe(true);
  });

  // EL CASO QUE CUESTA CARO. Santander rotula la liquidación de TARJETAS como
  // «depósito ventas del día»: si eso entrara por Caja, cada liquidación de
  // terminal del mes inventaría un movimiento de efectivo que nunca existió.
  it.each([
    "DEPOSITO VENTAS DEL DIA AFIL.-1234",
    "DEPOSITO VENTAS DEL DIA",
    "T20 SPEI RECIBIDO BANORTE",
    "HOSP HALTUS 09992889D",
    "Retiro efectivo",
    "Retiros efectivo",
    "PAGO CUENTA DE TERCERO",
    "TRASPASO 0000260814 , DE LA CUENTA",
  ])("no confunde «%s»", (d) => {
    expect(esDepositoEnEfectivo(d)).toBe(false);
  });
});
