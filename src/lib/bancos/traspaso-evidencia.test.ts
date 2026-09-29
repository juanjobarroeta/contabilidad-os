import { describe, expect, it } from "vitest";
import { cuentasDeContraparte, esDepositoEnEfectivo, evidenciaTraspaso, motivoSinEvidencia, type ContextoTraspaso, type MovimientoTraspaso } from "./traspaso-evidencia";

// Las cuentas de CENTRO (agosto 2026).
const ctxBase: ContextoTraspaso = {
  empresa: { rfc: "CPM2307076Z9", razonSocial: "CENTRO DE PROCEDIMIENTOS MINIMAMENTE INVASIVOS Y AMBULATORIOS" },
  cuentas: [
    { id: "bbva9012", numeroCuenta: "0120809012", clabe: "012650001208090123" },
    { id: "bbva5205", numeroCuenta: "0122355205", clabe: "012650001223552057" },
    { id: "banorte0258", numeroCuenta: "1358620258", clabe: "072 650 01358620258 0" },
  ],
  candidatosEspejo: [],
};

const mov = (m: Partial<MovimientoTraspaso>): MovimientoTraspaso => ({
  id: "t1",
  bankAccountId: "banorte0258",
  fecha: new Date("2026-08-14T12:00:00Z"),
  monto: 1000,
  descripcion: "",
  ...m,
});

describe("evidenciaTraspaso — lo que caja marcó como traspaso en CENTRO", () => {
  it("transferencia desde la cuenta Banorte de una persona: SIN evidencia", () => {
    const ev = evidenciaTraspaso(mov({ monto: 4536.6, descripcion: "TRASPASO 0000260815 , DE LA CUENTA: 1364983990 Devolucion" }), ctxBase);
    expect(ev.tiene).toBe(false);
    expect(ev.cuentasContraparte).toEqual(["1364983990"]);
    expect(motivoSinEvidencia(ev)).toContain("1364983990");
  });
  it("depósito en efectivo: SIN evidencia aunque diga «cuentas propias»", () => {
    const ev = evidenciaTraspaso(mov({ monto: 4638.4, descripcion: "DEP.EFECTIVO CUENTAS PROPIAS" }), ctxBase);
    expect(ev.tiene).toBe(false);
    expect(ev.esEfectivo).toBe(true);
  });
  it("SPEI de una persona: SIN evidencia", () => {
    const ev = evidenciaTraspaso(
      mov({ monto: 2038.6, contraparteNombre: "MARIANA MORALES VAZQUEZ DE LA", contraparteClabe: "012650015339770968", descripcion: "SPEI RECIBIDO, BCO:0012 BBVA MEXICO" }),
      ctxBase,
    );
    expect(ev.tiene).toBe(false);
  });
});

describe("evidenciaTraspaso — traspasos de verdad", () => {
  it("(a) espejo: cargo del mismo monto en otra cuenta de la empresa", () => {
    const ctx = { ...ctxBase, candidatosEspejo: [{ id: "c1", bankAccountId: "banorte0258", fecha: new Date("2026-08-05T10:00:00Z"), monto: -300000 }] };
    const ev = evidenciaTraspaso(mov({ bankAccountId: "bbva9012", monto: 300000, fecha: new Date("2026-08-05T15:00:00Z"), descripcion: "SPEI RECIBIDOBANORTE" }), ctx);
    expect(ev.tiene).toBe(true);
    expect(ev.espejoId).toBe("c1");
  });
  it("el espejo no vale en la MISMA cuenta ni con el mismo signo ni a más de 3 días", () => {
    const ctx = {
      ...ctxBase,
      candidatosEspejo: [
        { id: "misma", bankAccountId: "bbva9012", fecha: new Date("2026-08-05T10:00:00Z"), monto: -300000 },
        { id: "signo", bankAccountId: "banorte0258", fecha: new Date("2026-08-05T10:00:00Z"), monto: 300000 },
        { id: "lejos", bankAccountId: "banorte0258", fecha: new Date("2026-08-10T10:00:00Z"), monto: -300000 },
      ],
    };
    expect(evidenciaTraspaso(mov({ bankAccountId: "bbva9012", monto: 300000, fecha: new Date("2026-08-05T15:00:00Z") }), ctx).tiene).toBe(false);
  });
  it("un depósito en efectivo SÍ vale con espejo (retiro de otra cuenta propia)", () => {
    const ctx = { ...ctxBase, candidatosEspejo: [{ id: "ret", bankAccountId: "bbva9012", fecha: new Date("2026-08-14T09:00:00Z"), monto: -5000 }] };
    expect(evidenciaTraspaso(mov({ monto: 5000, descripcion: "DEP.EFECTIVO" }), ctx).tiene).toBe(true);
  });
  it("(b) la cuenta del concepto es de la empresa (número dentro de su CLABE)", () => {
    const ev = evidenciaTraspaso(mov({ bankAccountId: "bbva9012", descripcion: "TRASPASO DE CTA : 1358620258" }), ctxBase);
    expect(ev.razones.map((r) => r.regla)).toContain("traspaso.cuenta-propia");
  });
  it("(c) la contraparte es la empresa, por RFC o por razón social", () => {
    expect(evidenciaTraspaso(mov({ contraparteRfc: "cpm2307076z9" }), ctxBase).tiene).toBe(true);
    expect(evidenciaTraspaso(mov({ contraparteNombre: "CENTRO DE PROCEDIMIENTOS MIN" }), ctxBase).tiene).toBe(true);
  });
  it("(d) el concepto dice «cuentas propias»", () => {
    expect(evidenciaTraspaso(mov({ descripcion: "TRASPASO CUENTAS PROPIAS" }), ctxBase).tiene).toBe(true);
  });
  it("aplica igual a un CARGO: pagarle a un tercero no es traspaso", () => {
    expect(evidenciaTraspaso(mov({ monto: -8000, descripcion: "TRASPASO A CTA 1364983990" }), ctxBase).tiene).toBe(false);
  });
});

describe("auxiliares", () => {
  it("reconoce los depósitos en efectivo", () => {
    expect(esDepositoEnEfectivo("DEP.EFECTIVO")).toBe(true);
    expect(esDepositoEnEfectivo("C02 DEPOSITO EN EFECTIVO")).toBe(true);
    expect(esDepositoEnEfectivo("SPEI RECIBIDO")).toBe(false);
  });
  it("lee las cuentas del concepto y la CLABE", () => {
    expect(cuentasDeContraparte({ descripcion: "TRASPASO DE CTA : 1364984661", contraparteClabe: null })).toEqual(["1364984661"]);
    expect(cuentasDeContraparte({ descripcion: "SPEI", contraparteClabe: "012650015339770968" })).toEqual(["012650015339770968"]);
  });
});
