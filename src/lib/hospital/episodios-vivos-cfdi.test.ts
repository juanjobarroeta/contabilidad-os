import { describe, it, expect } from "vitest";
import { cargosQueAmpara, emparejarCfdi, enVentana, esCfdiDeAnticipo, type EpisodioVivo } from "./episodios-vivos-cfdi";

// ─────────────────────────────────────────────────────────────────────────────
// Un episodio capturado en piso y facturado fuera del módulo dejaba sus cargos
// sin factura: el CFDI caía entero a «otros ingresos» (honorarios incluidos).
// ─────────────────────────────────────────────────────────────────────────────

const F = (iso: string) => new Date(iso);
const cargo = (id: string, fecha: string, importe: number, ivaTasa: number | null = 0.16) => ({ id, fecha: F(fecha), importe, ivaTasa });

const ep = (over: Partial<EpisodioVivo> = {}): EpisodioVivo => ({
  id: "e1",
  folio: "HOSP-1",
  fechaIngreso: F("2026-08-10T10:00:00Z"),
  fechaAlta: F("2026-08-13T10:00:00Z"),
  cargos: [cargo("c1", "2026-08-10T12:00:00Z", 10000), cargo("c2", "2026-08-11T12:00:00Z", 5000, null), cargo("c3", "2026-08-12T12:00:00Z", 1000)],
  ...over,
});

describe("cargosQueAmpara", () => {
  it("la cuenta completa con IVA: 11,600 + 5,000 + 1,160", () => {
    expect(cargosQueAmpara(17760, ep().cargos)).toEqual(["c1", "c2", "c3"]);
  });
  it("una exhibición parcial: el prefijo cronológico", () => {
    expect(cargosQueAmpara(16600, ep().cargos)).toEqual(["c1", "c2"]);
  });
  it("tolerancia del mayor de $1 y 0.5 %", () => {
    expect(cargosQueAmpara(17760.9, ep().cargos)).toEqual(["c1", "c2", "c3"]);
    expect(cargosQueAmpara(17000, ep().cargos)).toBeNull();
  });
});

describe("emparejarCfdi", () => {
  it("un solo episodio empata → liga", () => {
    expect(emparejarCfdi({ total: 17760, fecha: F("2026-08-14T00:00:00Z") }, [ep()])).toEqual({ episodioId: "e1", cargoIds: ["c1", "c2", "c3"] });
  });
  it("fuera de la ventana (30 días después del alta) → pendiente", () => {
    const r = emparejarCfdi({ total: 17760, fecha: F("2026-10-20T00:00:00Z") }, [ep()]);
    expect(r.episodioId).toBeNull();
  });
  it("dos episodios que empatan → no se adivina", () => {
    const r = emparejarCfdi({ total: 17760, fecha: F("2026-08-14T00:00:00Z") }, [ep(), ep({ id: "e2", folio: "HOSP-2" })]);
    expect(r).toMatchObject({ episodioId: null, motivo: "empata con más de un episodio", candidatos: ["HOSP-1", "HOSP-2"] });
  });
  it("monto que no cuadra (reparto con aseguradora) → pendiente con candidatos", () => {
    const r = emparejarCfdi({ total: 9000, fecha: F("2026-08-14T00:00:00Z") }, [ep()]);
    expect(r).toMatchObject({ episodioId: null, candidatos: ["HOSP-1"] });
  });
  it("episodio abierto: la ventana llega hasta hoy + 30", () => {
    expect(enVentana(F("2026-09-20T00:00:00Z"), { fechaIngreso: F("2026-09-01T00:00:00Z"), fechaAlta: null }, F("2026-09-25T00:00:00Z"))).toBe(true);
  });
});

describe("esCfdiDeAnticipo", () => {
  it("clave 84111506 o conceptos «Anticipo…»", () => {
    expect(esCfdiDeAnticipo([{ claveProdServ: "84111506", descripcion: "Anticipo del bien o servicio" }])).toBe(true);
    expect(esCfdiDeAnticipo([{ claveProdServ: "85101500", descripcion: "Anticipo hospitalización" }])).toBe(true);
    expect(esCfdiDeAnticipo([{ claveProdServ: "85101500", descripcion: "Hospitalización" }])).toBe(false);
    expect(esCfdiDeAnticipo([])).toBe(false);
  });
});
