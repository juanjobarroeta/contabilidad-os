import { describe, it, expect } from "vitest";
import { calcularCuenta, calcularReparto, ivaContextoPorEpisodio, ivaTasaPorContexto, type CargoCuenta, type PagadorCuenta } from "./cuenta";

const cargo = (o: Partial<CargoCuenta> & Pick<CargoCuenta, "id" | "categoria" | "cantidad" | "precioUnitario" | "ivaTasa">): CargoCuenta => ({
  fecha: "2026-09-02T14:20:00.000Z",
  descripcion: o.id,
  origen: "MANUAL",
  cancelado: false,
  ...o,
});

// La cuenta de la lámina 8 (HOSP-2026-0418): subtotal $50,572.
const ORTEGA: CargoCuenta[] = [
  cargo({ id: "hab-1", categoria: "HABITACION", cantidad: 1, precioUnitario: 3200, ivaTasa: 0.16, origen: "ESTANCIA" }),
  cargo({ id: "hab-2", categoria: "HABITACION", cantidad: 1, precioUnitario: 3200, ivaTasa: 0.16, origen: "ESTANCIA" }),
  cargo({ id: "quir", categoria: "QUIROFANO", cantidad: 2.5, precioUnitario: 4800, ivaTasa: 0.16, origen: "EXPEDIENTE" }),
  cargo({ id: "recu", categoria: "HABITACION", cantidad: 2, precioUnitario: 1300, ivaTasa: 0.16 }),
  cargo({ id: "cefa", categoria: "FARMACIA", cantidad: 6, precioUnitario: 85, ivaTasa: 0, origen: "FARMACIA", lote: { lote: "L-2291" } }),
  cargo({ id: "prop", categoria: "FARMACIA", cantidad: 1, precioUnitario: 214, ivaTasa: 0, origen: "FARMACIA", lote: "P-1174" }),
  cargo({ id: "hart", categoria: "FARMACIA", cantidad: 4, precioUnitario: 62, ivaTasa: 0, origen: "FARMACIA" }),
  cargo({ id: "histo", categoria: "ESTUDIO", cantidad: 1, precioUnitario: 1420, ivaTasa: 0.16 }),
  cargo({ id: "lab", categoria: "ESTUDIO", cantidad: 1, precioUnitario: 680, ivaTasa: 0.16 }),
  cargo({ id: "vega", categoria: "HONORARIO", cantidad: 1, precioUnitario: 18000, ivaTasa: null, medico: { id: "m1", nombre: "Dr. Alonso Vega" } }),
  cargo({ id: "rent", categoria: "HONORARIO", cantidad: 1, precioUnitario: 8500, ivaTasa: null, medico: { id: "m2", nombre: "Dra. Claudia Rentería" } }),
];

const GNP: PagadorCuenta = {
  nombre: "GNP Seguros",
  tipo: "ASEGURADORA",
  deducible: 8500,
  coaseguroPct: 0.1,
  plazoDias: 45,
  topeAutorizacion: 60000,
};

describe("calcularCuenta — la cuenta de M. F. Ortega (lámina 8)", () => {
  const cuenta = calcularCuenta({ cargos: ORTEGA, pagador: GNP, config: { topeAutorizacion: 50000 } });

  it("agrupa en los tres grupos fijos con sus títulos", () => {
    expect(cuenta.grupos.map((g) => g.titulo)).toEqual([
      "Hospitalización y quirófano",
      "Farmacia y material · sale con su lote",
      "Estudios y honorarios",
    ]);
    expect(cuenta.grupos[0].cargos.map((c) => c.id)).toEqual(["hab-1", "hab-2", "quir", "recu"]);
    expect(cuenta.grupos[1].cargos.map((c) => c.id)).toEqual(["cefa", "prop", "hart"]);
    expect(cuenta.grupos[2].cargos.map((c) => c.id)).toEqual(["histo", "lab", "vega", "rent"]);
  });

  it("calcula IVA por renglón: 16 % gravado, 0 % farmacia, null exento", () => {
    const quir = cuenta.grupos[0].cargos.find((c) => c.id === "quir")!;
    expect(quir).toMatchObject({ importe: 12000, iva: 1920, total: 13920, ivaTasa: 0.16 });
    const cefa = cuenta.grupos[1].cargos.find((c) => c.id === "cefa")!;
    expect(cefa).toMatchObject({ importe: 510, iva: 0, total: 510, lote: "L-2291" });
    expect(cuenta.grupos[1].cargos.find((c) => c.id === "prop")!.lote).toBe("P-1174");
    const vega = cuenta.grupos[2].cargos.find((c) => c.id === "vega")!;
    expect(vega).toMatchObject({ importe: 18000, iva: 0, ivaTasa: null, medico: { nombre: "Dr. Alonso Vega" } });
  });

  it("subtotal $50,572 con los honorarios separados del hospital", () => {
    expect(cuenta.grupos[0]).toMatchObject({ subtotal: 21000, iva: 3360, total: 24360 });
    expect(cuenta.grupos[1]).toMatchObject({ subtotal: 972, iva: 0, total: 972 });
    expect(cuenta.grupos[2]).toMatchObject({ subtotal: 28600, iva: 336, total: 28936 });
    expect(cuenta.totales).toEqual({
      subtotal: 50572,
      iva: 3696,
      total: 54268,
      honorarios: 26500,
      hospital: 27768,
    });
  });

  it("reparte sobre el subtotal: deducible + coaseguro al paciente, el resto a GNP", () => {
    // 8,500 + 10 % × (50,572 − 8,500) = 8,500 + 4,207.20
    expect(cuenta.reparto).toMatchObject({
      base: 50572,
      deducible: 8500,
      coaseguro: 4207.2,
      paciente: 12707.2,
      aseguradora: 37864.8,
      requiereAutorizacion: false,
      topeAutorizacion: 60000,
    });
    expect(cuenta.reparto.paciente + cuenta.reparto.aseguradora).toBeCloseTo(cuenta.reparto.base, 2);
  });

  it("las cifras de la propuesta (9,860 / 1,360) salen de la misma fórmula con base 22,100", () => {
    // La lámina 15 muestra deducible 8,500 + coaseguro 1,360 = 9,860: es la
    // fórmula del convenio aplicada a una cuenta de 22,100, no a la de 50,572.
    expect(calcularReparto(22100, GNP)).toMatchObject({ deducible: 8500, coaseguro: 1360, paciente: 9860, aseguradora: 12240 });
  });
});

describe("calcularCuenta — casos del reparto", () => {
  const cargos = [cargo({ id: "a", categoria: "QUIROFANO", cantidad: 1, precioUnitario: 10000, ivaTasa: 0.16 })];

  it("sin pagador todo al paciente", () => {
    const c = calcularCuenta({ cargos });
    expect(c.reparto).toMatchObject({ pagador: null, base: 10000, paciente: 10000, aseguradora: 0, deducible: 0, coaseguro: 0 });
  });

  it("PARTICULAR todo al paciente aunque el convenio traiga deducible", () => {
    const c = calcularCuenta({
      cargos,
      pagador: { nombre: "Particular", tipo: "PARTICULAR", deducible: 5000, coaseguroPct: 0.1, plazoDias: 0, topeAutorizacion: null },
    });
    expect(c.reparto).toMatchObject({ paciente: 10000, aseguradora: 0 });
  });

  it("EMPRESA sin deducible ni coaseguro paga todo", () => {
    const c = calcularCuenta({
      cargos,
      pagador: { nombre: "Textil del Valle", tipo: "EMPRESA", deducible: null, coaseguroPct: 0, plazoDias: 30, topeAutorizacion: null },
    });
    expect(c.reparto).toMatchObject({ paciente: 0, aseguradora: 10000 });
  });

  it("el deducible no rebasa la base", () => {
    const c = calcularCuenta({
      cargos,
      pagador: { nombre: "AXA", tipo: "ASEGURADORA", deducible: 12000, coaseguroPct: 0.1, plazoDias: 60, topeAutorizacion: null },
    });
    expect(c.reparto).toMatchObject({ deducible: 10000, coaseguro: 0, paciente: 10000, aseguradora: 0 });
  });

  it("requiereAutorizacion usa el tope del convenio y, si no hay, el de la empresa", () => {
    const pag: PagadorCuenta = { nombre: "GNP", tipo: "ASEGURADORA", deducible: 0, coaseguroPct: 0, plazoDias: 45, topeAutorizacion: 8000 };
    expect(calcularCuenta({ cargos, pagador: pag }).reparto.requiereAutorizacion).toBe(true);
    expect(calcularCuenta({ cargos, pagador: { ...pag, topeAutorizacion: null }, config: { topeAutorizacion: 60000 } }).reparto.requiereAutorizacion).toBe(false);
    expect(calcularCuenta({ cargos, pagador: { ...pag, topeAutorizacion: null } }).reparto.requiereAutorizacion).toBe(false);
  });

  it("los cancelados se listan pero no suman", () => {
    const c = calcularCuenta({
      cargos: [...cargos, cargo({ id: "x", categoria: "QUIROFANO", cantidad: 1, precioUnitario: 999, ivaTasa: 0.16, cancelado: true, motivoCancelacion: "duplicado" })],
    });
    expect(c.grupos[0].cargos).toHaveLength(2);
    expect(c.grupos[0].cargos[1]).toMatchObject({ cancelado: true, motivoCancelacion: "duplicado", importe: 999 });
    expect(c.totales.subtotal).toBe(10000);
    expect(c.reparto.base).toBe(10000);
  });

  it("usa el importe guardado cuando viene y lo calcula cuando no", () => {
    const c = calcularCuenta({
      cargos: [
        cargo({ id: "g", categoria: "ESTUDIO", cantidad: 3, precioUnitario: 100, ivaTasa: 0.16, importe: 250 }),
        cargo({ id: "h", categoria: "ESTUDIO", cantidad: 3, precioUnitario: 100, ivaTasa: 0.16 }),
      ],
    });
    expect(c.grupos[2].cargos.map((r) => r.importe)).toEqual([250, 300]);
    expect(c.totales.iva).toBe(88);
  });
});

describe("IVA de farmacia por contexto (criterio 9/IVA/N)", () => {
  it("suministro hospitalario: la medicina toma la tasa de la config; venta directa: la del insumo", () => {
    expect(ivaTasaPorContexto({ contexto: "SUMINISTRO_HOSPITALARIO", categoria: "FARMACIA", ivaTasaInsumo: 0, ivaMedicinasHospitalizacion: 0.16 })).toBe(0.16);
    expect(ivaTasaPorContexto({ contexto: "VENTA_DIRECTA", categoria: "FARMACIA", ivaTasaInsumo: 0, ivaMedicinasHospitalizacion: 0.16 })).toBe(0);
    // Sin config: 16 %. El contador que sigue a PRODECON fija 0 y se respeta.
    expect(ivaTasaPorContexto({ contexto: "SUMINISTRO_HOSPITALARIO", categoria: "FARMACIA", ivaTasaInsumo: 0 })).toBe(0.16);
    expect(ivaTasaPorContexto({ contexto: "SUMINISTRO_HOSPITALARIO", categoria: "FARMACIA", ivaTasaInsumo: 0, ivaMedicinasHospitalizacion: 0 })).toBe(0);
  });

  it("el material de curación grava igual en los dos contextos", () => {
    expect(ivaTasaPorContexto({ contexto: "SUMINISTRO_HOSPITALARIO", categoria: "MATERIAL", ivaTasaInsumo: 0.16, ivaMedicinasHospitalizacion: 0 })).toBe(0.16);
    expect(ivaTasaPorContexto({ contexto: "VENTA_DIRECTA", categoria: "MATERIAL", ivaTasaInsumo: 0.16, ivaMedicinasHospitalizacion: 0.16 })).toBe(0.16);
  });

  it("el contexto nace del tipo de episodio: consulta vende, lo demás suministra", () => {
    expect(ivaContextoPorEpisodio("HOSPITALIZACION")).toBe("SUMINISTRO_HOSPITALARIO");
    expect(ivaContextoPorEpisodio("AMBULATORIO")).toBe("SUMINISTRO_HOSPITALARIO");
    expect(ivaContextoPorEpisodio("URGENCIAS")).toBe("SUMINISTRO_HOSPITALARIO");
    expect(ivaContextoPorEpisodio("CONSULTA")).toBe("VENTA_DIRECTA");
  });

  it("la cuenta enseña el contexto por renglón y parte farmacia como se factura (16 / 0)", () => {
    const c = calcularCuenta({
      cargos: [
        cargo({ id: "a", categoria: "FARMACIA", cantidad: 2, precioUnitario: 100, ivaTasa: 0.16, origen: "FARMACIA", ivaContexto: "SUMINISTRO_HOSPITALARIO" }),
        cargo({ id: "b", categoria: "FARMACIA", cantidad: 1, precioUnitario: 50, ivaTasa: 0, origen: "FARMACIA", ivaContexto: "VENTA_DIRECTA" }),
        cargo({ id: "c", categoria: "MATERIAL", cantidad: 1, precioUnitario: 30, ivaTasa: 0.16, origen: "FARMACIA" }),
        cargo({ id: "d", categoria: "FARMACIA", cantidad: 1, precioUnitario: 999, ivaTasa: 0.16, origen: "FARMACIA", ivaContexto: "SUMINISTRO_HOSPITALARIO", cancelado: true }),
        cargo({ id: "e", categoria: "QUIROFANO", cantidad: 1, precioUnitario: 1000, ivaTasa: 0.16 }),
      ],
    });
    const farmacia = c.grupos[1];
    expect(farmacia.cargos.map((r) => r.ivaContexto)).toEqual(["SUMINISTRO_HOSPITALARIO", "VENTA_DIRECTA", null, "SUMINISTRO_HOSPITALARIO"]);
    expect(farmacia.porIvaContexto).toEqual({
      SUMINISTRO_HOSPITALARIO: { subtotal: 200, iva: 32, total: 232 },
      VENTA_DIRECTA: { subtotal: 50, iva: 0, total: 50 },
      SIN_CONTEXTO: { subtotal: 30, iva: 4.8, total: 34.8 },
    });
    expect(farmacia).toMatchObject({ subtotal: 280, iva: 36.8, total: 316.8 });
    // Los otros grupos no llevan el corte.
    expect(c.grupos[0].porIvaContexto).toBeUndefined();
    expect(c.grupos[2].porIvaContexto).toBeUndefined();
  });
});
