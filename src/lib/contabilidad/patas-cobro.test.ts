import { describe, expect, it } from "vitest";
import { patasDeCobro } from "./posting";

const CTAS = {
  ctaBancoId: "banco",
  ctaCajaId: "caja",
  ctaCobroId: "clientes",
  ctaAnticiposId: "anticipos",
};

const suma = (patas: ReturnType<typeof patasDeCobro>, tipo: "CARGO" | "ABONO") =>
  patas.filter((p) => p.tipo === tipo).reduce((s, p) => s + p.monto, 0);

const neto = (patas: ReturnType<typeof patasDeCobro>, cuenta: string) =>
  patas
    .filter((p) => p.chartAccountId === cuenta)
    .reduce((s, p) => s + (p.tipo === "CARGO" ? p.monto : -p.monto), 0);

describe("patasDeCobro", () => {
  describe("cobro que llega por transferencia (como siempre)", () => {
    const patas = patasDeCobro({ ...CTAS, enEfectivo: false, absAmount: 10_000, asignado: 10_000, sobrante: 0 });

    it("carga el banco y abona al cliente, sin tocar caja", () => {
      expect(patas).toEqual([
        { chartAccountId: "banco", monto: 10_000, tipo: "CARGO" },
        { chartAccountId: "clientes", monto: 10_000, tipo: "ABONO" },
      ]);
      expect(neto(patas, "caja")).toBe(0);
    });
  });

  describe("cobro en efectivo", () => {
    const patas = patasDeCobro({ ...CTAS, enEfectivo: true, absAmount: 200_000, asignado: 200_000, sobrante: 0 });

    // Lo que pidió el hospital: el dinero entró por la caja y de ahí se
    // depositó. Si esto se postea como DR Bancos / AB Clientes, el libro dice
    // que el paciente transfirió.
    it("el cobro entra por caja y el depósito la vacía", () => {
      expect(patas).toEqual([
        { chartAccountId: "caja", monto: 200_000, tipo: "CARGO" },
        { chartAccountId: "banco", monto: 200_000, tipo: "CARGO", traspaso: true },
        { chartAccountId: "caja", monto: 200_000, tipo: "ABONO", traspaso: true },
        { chartAccountId: "clientes", monto: 200_000, tipo: "ABONO" },
      ]);
    });

    it("el banco termina igual que si hubiera entrado directo", () => {
      expect(neto(patas, "banco")).toBe(200_000);
    });

    // Mientras el cobro no se capture con su propia fecha, las dos patas caen
    // el día del depósito y caja no debe quedar con saldo inventado.
    it("caja queda neta en cero", () => {
      expect(neto(patas, "caja")).toBe(0);
    });

    it("separa el traspaso del cobro para que lleven descripción distinta", () => {
      expect(patas.filter((p) => p.traspaso)).toHaveLength(2);
    });
  });

  describe("partida doble", () => {
    it.each([
      ["transferencia completa", false, 10_000, 10_000, 0],
      ["transferencia con sobrante", false, 50_000, 3_000, 47_000],
      ["efectivo completo", true, 200_000, 200_000, 0],
      ["efectivo con sobrante a anticipos", true, 200_000, 97_941.45, 102_058.55],
      ["efectivo todo a anticipos", true, 5_000, 0, 5_000],
    ])("cuadra: %s", (_, enEfectivo, absAmount, asignado, sobrante) => {
      const patas = patasDeCobro({ ...CTAS, enEfectivo, absAmount, asignado, sobrante });
      expect(suma(patas, "CARGO")).toBeCloseTo(suma(patas, "ABONO"), 2);
      expect(neto(patas, "banco")).toBeCloseTo(absAmount, 2);
      expect(neto(patas, "caja")).toBe(0);
    });
  });

  // El reparto ya redondea; estas ramas sólo existen para no escribir patas de
  // centavos fantasma que ensucian la póliza.
  it("no escribe patas por importes despreciables", () => {
    const patas = patasDeCobro({ ...CTAS, enEfectivo: false, absAmount: 100, asignado: 100, sobrante: 0.004 });
    expect(patas.some((p) => p.chartAccountId === "anticipos")).toBe(false);
  });
});
