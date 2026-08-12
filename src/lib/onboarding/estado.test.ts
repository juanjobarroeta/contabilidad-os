import { describe, expect, it } from "vitest";
import {
  avanceGlobal,
  cargaCompleta,
  cronsPendientes,
  empresasPorAtender,
  evaluarEtapas,
  type ConteosEmpresa,
} from "./estado";

const base: ConteosEmpresa = {
  companyId: "c1",
  total: 1000,
  conXml: 1000,
  conImpuestos: 1000,
  conContraparte: 1000,
  conVigencia: 1000,
  backfillCompleto: true,
};

describe("evaluarEtapas", () => {
  it("empresa al corriente: todas las etapas completas", () => {
    const etapas = evaluarEtapas(base);
    expect(cargaCompleta(etapas)).toBe(true);
    expect(cronsPendientes(etapas)).toEqual([]);
  });

  it("tolera un residuo legítimo (98%): no deja a nadie cargando por 3 filas", () => {
    const etapas = evaluarEtapas({ ...base, conContraparte: 985 });
    expect(etapas.find((e) => e.clave === "contraparte")!.completa).toBe(true);
  });

  it("por debajo del umbral la etapa sigue pendiente", () => {
    const etapas = evaluarEtapas({ ...base, conContraparte: 900 });
    expect(etapas.find((e) => e.clave === "contraparte")!.completa).toBe(false);
  });

  it("sin CFDIs todavía, las etapas derivadas no se empujan en vano", () => {
    const etapas = evaluarEtapas({
      companyId: "c1", total: 0, conXml: 0, conImpuestos: 0,
      conContraparte: 0, conVigencia: 0, backfillCompleto: false,
    });
    // La descarga sigue pendiente, pero nada derivado se empuja: no hay de qué.
    expect(etapas.find((e) => e.clave === "cfdis")!.completa).toBe(false);
    expect(etapas.filter((e) => e.clave !== "cfdis").every((e) => e.completa)).toBe(true);
    // Y la descarga no tiene cron que empujar (sat-backfill ya prioriza solo).
    expect(cronsPendientes(etapas)).toEqual([]);
  });
});

describe("cronsPendientes (respeta la cadena)", () => {
  it("empuja SÓLO el primer eslabón incompleto", () => {
    // Sin XML no tiene caso derivar impuestos ni contraparte de él.
    const etapas = evaluarEtapas({
      ...base, conXml: 100, conImpuestos: 0, conContraparte: 0, conVigencia: 0,
    });
    expect(cronsPendientes(etapas)).toEqual(["sat-rawxml-backfill"]);
  });

  it("con el XML listo, pasa al siguiente eslabón", () => {
    const etapas = evaluarEtapas({ ...base, conImpuestos: 0, conContraparte: 0, conVigencia: 0 });
    expect(cronsPendientes(etapas)).toEqual(["invoice-taxes-backfill"]);
  });

  it("hasta llegar a la verificación de cancelaciones", () => {
    const etapas = evaluarEtapas({ ...base, conVigencia: 0 });
    expect(cronsPendientes(etapas)).toEqual(["sat-vigencia-sync"]);
  });
});

describe("empresasPorAtender", () => {
  it("atiende primero a la MÁS atrasada", () => {
    const casi: ConteosEmpresa = { ...base, companyId: "casi", conVigencia: 0 };
    const nueva: ConteosEmpresa = {
      ...base, companyId: "nueva", conXml: 50, conImpuestos: 0,
      conContraparte: 0, conVigencia: 0,
    };
    const orden = empresasPorAtender([casi, nueva], 2).map((e) => e.companyId);
    expect(orden[0]).toBe("nueva");
  });

  it("excluye a las que ya están al corriente", () => {
    const pendiente = { ...base, companyId: "pendiente", conVigencia: 0 };
    const atender = empresasPorAtender([base, pendiente], 5);
    expect(atender.map((e) => e.companyId)).toEqual(["pendiente"]);
  });

  it("respeta el tope de empresas por corrida", () => {
    const muchas = Array.from({ length: 10 }, (_, i) => ({
      ...base, companyId: `c${i}`, conVigencia: 0,
    }));
    expect(empresasPorAtender(muchas, 3)).toHaveLength(3);
  });

  it("portafolio al corriente → nadie que atender (no-op barato)", () => {
    expect(empresasPorAtender([base, { ...base, companyId: "c2" }], 5)).toEqual([]);
  });
});

describe("avanceGlobal", () => {
  it("promedia sólo las etapas medibles", () => {
    expect(avanceGlobal(evaluarEtapas(base))).toBe(1);
    expect(avanceGlobal(evaluarEtapas({ ...base, conVigencia: 0 }))).toBeLessThan(1);
  });
});
