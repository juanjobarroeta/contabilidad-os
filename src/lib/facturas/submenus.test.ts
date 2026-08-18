import { describe, it, expect } from "vitest";
import { submenusFacturas, type Submenu } from "./submenus";

const find = (ms: Submenu[], v: string) => ms.find((m) => m.v === v)!;

describe("submenusFacturas", () => {
  it("Comprobantes conserva el total: esa pestaña es el archivo", () => {
    const m = find(submenusFacturas({ comprobantes: 184, prefacturas: 0, repPorEmitir: null }), "comprobantes");
    expect(m.n).toBe(184);
    expect(m.tono).toBe("neutral");
  });

  it("Complementos cuenta lo que FALTA emitir, no los REP que existen", () => {
    // 184 REP en el archivo, pero sólo 3 cobros esperan complemento: la
    // insignia debe decir 3. Ese era justo el número que engañaba.
    const m = find(
      submenusFacturas({ comprobantes: 184, prefacturas: 0, repPorEmitir: { sinRep: 3, vencidos: 0 } }),
      "complementos"
    );
    expect(m.n).toBe(3);
  });

  it("con cobros dentro de plazo el tono es ámbar", () => {
    const m = find(
      submenusFacturas({ comprobantes: 10, prefacturas: 0, repPorEmitir: { sinRep: 2, vencidos: 0 } }),
      "complementos"
    );
    expect(m.tono).toBe("amber");
    expect(m.hint).toContain("día 5 del mes siguiente");
  });

  it("un solo vencido pinta la pestaña en rojo y lo dice en el tooltip", () => {
    const m = find(
      submenusFacturas({ comprobantes: 10, prefacturas: 0, repPorEmitir: { sinRep: 4, vencidos: 1 } }),
      "complementos"
    );
    expect(m.tono).toBe("red");
    expect(m.hint).toContain("plazo legal");
  });

  it("sin cobros pendientes no hay insignia ni urgencia", () => {
    const m = find(
      submenusFacturas({ comprobantes: 10, prefacturas: 0, repPorEmitir: { sinRep: 0, vencidos: 0 } }),
      "complementos"
    );
    expect(m.n).toBeNull();
    expect(m.tono).toBe("neutral");
  });

  it("sin datos de REP todavía (carga en vuelo) la pestaña no inventa un número", () => {
    const m = find(submenusFacturas({ comprobantes: 10, prefacturas: 0, repPorEmitir: null }), "complementos");
    expect(m.n).toBeNull();
    expect(m.tono).toBe("neutral");
  });

  it("las prefacturas guardadas van en ámbar: esperan, no incumplen", () => {
    const m = find(submenusFacturas({ comprobantes: 0, prefacturas: 2, repPorEmitir: null }), "prefacturas");
    expect(m.n).toBe(2);
    expect(m.tono).toBe("amber");
  });

  it("cero prefacturas no pinta insignia", () => {
    const m = find(submenusFacturas({ comprobantes: 0, prefacturas: 0, repPorEmitir: null }), "prefacturas");
    expect(m.n).toBeNull();
    expect(m.tono).toBe("neutral");
  });

  it("siempre devuelve las tres pestañas en orden", () => {
    const ms = submenusFacturas({ comprobantes: null, prefacturas: 0, repPorEmitir: null });
    expect(ms.map((m) => m.v)).toEqual(["comprobantes", "complementos", "prefacturas"]);
  });
});
