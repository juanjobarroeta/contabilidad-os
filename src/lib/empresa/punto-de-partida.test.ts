import { describe, it, expect } from "vitest";
import { evaluarPuntoDePartida, type HechosPuntoDePartida } from "./punto-de-partida";

const base: HechosPuntoDePartida = {
  hoy: new Date("2026-09-14T12:00:00Z"),
  fiel: "ok",
  fielVigencia: new Date("2028-01-10T00:00:00Z"),
  obligaciones: 4,
  cuentasPropias: 2340,
  ultimaCargaCatalogo: new Date("2026-09-12T20:00:00Z"),
  ultimaBalanzaSat: { anio: 2026, mes: 7 },
  aperturaHecha: true,
  cuentasBancarias: 4,
  ultimoEstadoDeCuenta: "2026-08",
  cfdis: 12034,
  ultimaSincronizacionSat: new Date("2026-09-13T06:00:00Z"),
};

describe("evaluarPuntoDePartida", () => {
  it("empresa completa: seis de seis, nada que pedir", () => {
    const r = evaluarPuntoDePartida(base);
    expect(r.listos).toBe(6);
    expect(r.total).toBe(6);
    expect(r.siguiente).toBeNull();
    expect(r.pasos.every((p) => !p.peticion)).toBe(true);
  });

  it("empresa recién dada de alta sin e.firma: todo falta y cada paso dice qué archivo pedir", () => {
    const r = evaluarPuntoDePartida({ ...base, fiel: "sin_fiel", fielVigencia: null, obligaciones: 0, cuentasPropias: 0, ultimaCargaCatalogo: null, ultimaBalanzaSat: null, aperturaHecha: false, cuentasBancarias: 0, ultimoEstadoDeCuenta: null, cfdis: 0, ultimaSincronizacionSat: null });
    expect(r.listos).toBe(0);
    expect(r.pasos.map((p) => p.estado)).toEqual(["falta", "falta", "falta", "falta", "falta", "falta"]);
    expect(r.siguiente?.clave).toBe("csf");
    const catalogo = r.pasos.find((p) => p.clave === "catalogo")!;
    expect(catalogo.peticion).toContain("CSV/Excel");
    expect(catalogo.peticion).toContain("Anexo 24");
    expect(catalogo.href).toBe("#contabilidad-electronica");
  });

  it("con e.firma vigente, catálogo, balanza y CFDI son «parcial»: los bajamos nosotros, con la alternativa de subirlos", () => {
    const r = evaluarPuntoDePartida({ ...base, cuentasPropias: 0, ultimaCargaCatalogo: null, ultimaBalanzaSat: null, aperturaHecha: false, cfdis: 0 });
    const por = Object.fromEntries(r.pasos.map((p) => [p.clave, p]));
    expect(por.catalogo.estado).toBe("parcial");
    expect(por.catalogo.peticion).toContain("Lo bajamos del SAT con tu e.firma");
    expect(por.saldos.estado).toBe("parcial");
    expect(por.cfdi.estado).toBe("parcial");
    expect(r.siguiente?.clave).toBe("catalogo");
  });

  it("balanza del SAT ya bajada pero sin apertura: parcial y pide generar la apertura", () => {
    const r = evaluarPuntoDePartida({ ...base, aperturaHecha: false });
    const saldos = r.pasos.find((p) => p.clave === "saldos")!;
    expect(saldos.estado).toBe("parcial");
    expect(saldos.detalle).toBe("Tenemos tu balanza del SAT de julio 2026");
  });

  it("e.firma por vencer y bancos sin estados: parciales con su petición", () => {
    const r = evaluarPuntoDePartida({ ...base, fiel: "por_vencer", fielVigencia: new Date("2026-10-01T00:00:00Z"), ultimoEstadoDeCuenta: null });
    const por = Object.fromEntries(r.pasos.map((p) => [p.clave, p]));
    expect(por.fiel.estado).toBe("parcial");
    expect(por.fiel.peticion).toContain("Renueva");
    expect(por.bancos.estado).toBe("parcial");
    expect(por.bancos.detalle).toBe("4 cuenta(s) sin estados de cuenta");
    expect(r.listos).toBe(4);
  });

  it("e.firma vencida cuenta como falta", () => {
    const r = evaluarPuntoDePartida({ ...base, fiel: "vencida" });
    expect(r.pasos.find((p) => p.clave === "fiel")?.estado).toBe("falta");
  });
});
