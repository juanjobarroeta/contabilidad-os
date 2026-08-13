import { describe, expect, it } from "vitest";
import { agruparHallazgos, type HallazgoParaSintesis } from "./sintesis";

const h = (
  checkClave: string,
  severidad: string,
  mensaje: string,
  sugerencia = "Revisa el comprobante.",
): HallazgoParaSintesis => ({
  checkClave,
  severidad,
  mensaje,
  sugerencia,
  fundamentoLey: "LISR",
  fundamentoArticulo: "Art. 27",
});

describe("agruparHallazgos", () => {
  it("agrupa por causa raíz (checkClave) con conteo", () => {
    const grupos = agruparHallazgos([
      h("deduccion.combustible.efectivo", "warn", "Gasolina pagada en efectivo $500"),
      h("deduccion.combustible.efectivo", "warn", "Gasolina pagada en efectivo $800"),
      h("cfdi.duplicado", "error", "Posible CFDI duplicado por $10,000"),
    ]);
    expect(grupos.map((g) => [g.clave, g.n])).toEqual([
      ["cfdi.duplicado", 1],
      ["deduccion.combustible.efectivo", 2],
    ]);
  });

  it("ordena error > warn > info y, dentro, por tamaño del grupo", () => {
    const grupos = agruparHallazgos([
      h("a.info", "info", "x"),
      h("b.warn.chico", "warn", "x"),
      h("c.warn.grande", "warn", "x"),
      h("c.warn.grande", "warn", "x"),
      h("d.error", "error", "x"),
    ]);
    expect(grupos.map((g) => g.clave)).toEqual(["d.error", "c.warn.grande", "b.warn.chico", "a.info"]);
  });

  it("la severidad del grupo es la PEOR de sus hallazgos", () => {
    const [g] = agruparHallazgos([
      h("mixto.check", "info", "leve"),
      h("mixto.check", "error", "grave"),
    ]);
    expect(g.severidad).toBe("error");
  });

  it("acota los ejemplos a 5 aunque el grupo tenga cientos", () => {
    const muchos = Array.from({ length: 200 }, (_, i) => h("pue.sin_pago", "warn", `PUE sin cobro #${i}`));
    const [g] = agruparHallazgos(muchos);
    expect(g.n).toBe(200);
    expect(g.ejemplos).toHaveLength(5);
  });

  it("lista vacía → sin grupos (el brief queda limpio sin gastar tokens)", () => {
    expect(agruparHallazgos([])).toEqual([]);
  });
});
