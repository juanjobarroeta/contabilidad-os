import { describe, it, expect, beforeAll } from "vitest";
import * as XLSX from "xlsx";
import { construirXlsx, filtrosSchema, resumir, tituloReporte, whereDeFiltros, type RenglonReporte } from "./reporte-facturas";
import { decidirAccesoFacturas, firmarDescarga, textoResumen, verificarDescarga } from "./reporte-servicio";

beforeAll(() => { process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "secreto-de-prueba"; });

const renglon = (p: Partial<RenglonReporte>): RenglonReporte => ({
  id: "f", fecha: "2026-08-01", serieFolio: "A-1", uuid: "U", direccion: "RECIBIDA", tipo: "Ingreso", emisor: "PROV", receptor: "CENTRO",
  contraparte: "PROV", contraparteRfc: "PRO010101AAA", subtotal: 100, descuento: 0, iva: 16, retenciones: 0, total: 116, moneda: "MXN",
  metodoPago: "PPD", estado: "STAMPED", pagado: 0, saldo: 116, tieneXml: true, ...p,
});

describe("filtros del reporte", () => {
  it("valida fechas y aplica valores por omisión", () => {
    expect(filtrosSchema.parse({})).toMatchObject({ direccion: "AMBAS", estado: "VIGENTES", saldo: "TODAS" });
    expect(() => filtrosSchema.parse({ desde: "2026-09-01", hasta: "2026-01-01" })).toThrow(/posterior/);
    expect(() => filtrosSchema.parse({ desde: "1/9/2026" })).toThrow();
    expect(() => filtrosSchema.parse({ companyId: "otra" })).toThrow();
  });
  it("el where queda acotado a la empresa, contrapartes, periodo y dirección", () => {
    const w = whereDeFiltros("co1", filtrosSchema.parse({ desde: "2026-01-01", hasta: "2026-09-30", direccion: "RECIBIDAS", metodoPago: "PPD" }), ["c1", "c2"]) as { AND: Record<string, unknown>[] };
    expect(w.AND).toContainEqual({ companyId: "co1" });
    expect(w.AND).toContainEqual({ customerId: { in: ["c1", "c2"] } });
    expect(w.AND).toContainEqual({ tipo: { in: ["EGRESO", "PAGO"] } });
    expect(w.AND).toContainEqual({ status: "STAMPED" });
    expect(w.AND).toContainEqual({ metodoPago: "PPD" });
    expect(JSON.stringify(w.AND)).toContain("2026-09-30T23:59:59.999Z");
  });
});

describe("resumen", () => {
  it("suma vigentes, resta notas de crédito y desglosa por contraparte", () => {
    const r = resumir([
      renglon({ id: "1", total: 116, saldo: 116, iva: 16 }),
      renglon({ id: "2", total: 58, saldo: 0, pagado: 58, iva: 8, contraparte: "OTRO", contraparteRfc: "OTR010101AAA" }),
      renglon({ id: "3", tipo: "Nota de crédito", total: 11.6, saldo: 0, iva: 1.6 }),
      renglon({ id: "4", estado: "CANCELLED", total: 1000 }),
    ]);
    expect(r.facturas).toBe(4);
    expect(r.total).toBe(162.4);
    expect(r.iva).toBe(22.4);
    expect(r.porContraparte.map((p) => [p.rfc, p.facturas, p.total])).toEqual([["PRO010101AAA", 2, 104.4], ["OTR010101AAA", 1, 58]]);
  });
  it("el texto del chat lleva las cifras de la consulta", () => {
    const resumen = resumir([renglon({})]);
    const t = textoResumen({ estado: "LISTO", id: "r", titulo: "Facturas recibidas de PROV", resumen, cortado: false });
    expect(t).toContain("1 CFDI");
    expect(t).toContain("$116.00");
  });
  it("el título dice quién y cuándo", () => {
    expect(tituloReporte(filtrosSchema.parse({ direccion: "RECIBIDAS", desde: "2026-01-01", hasta: "2026-09-30" }), ["PROVEEDORA NACIONAL"])).toBe("Facturas recibidas de PROVEEDORA NACIONAL · 2026-01-01 a 2026-09-30");
  });
});

describe("Excel", () => {
  it("trae la hoja de facturas y la de resumen con los importes", () => {
    const rows = [renglon({ id: "1" }), renglon({ id: "2", total: 58, iva: 8 })];
    const wb = XLSX.read(construirXlsx(rows, resumir(rows), "t"), { type: "buffer" });
    expect(wb.SheetNames).toEqual(["Facturas", "Resumen"]);
    const det = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets.Facturas);
    expect(det).toHaveLength(2);
    expect(det[0]).toMatchObject({ "Serie-Folio": "A-1", Total: 116, Saldo: 116, Dirección: "Recibida" });
  });
});

describe("permisos", () => {
  it("sólo quien ve facturas", () => {
    expect(decidirAccesoFacturas({ miembro: false, allowedModules: [], hospitalPaginas: [] }).ok).toBe(false);
    expect(decidirAccesoFacturas({ miembro: true, allowedModules: [], hospitalPaginas: [] }).ok).toBe(true);
    expect(decidirAccesoFacturas({ miembro: true, allowedModules: ["HOSPITAL"], hospitalPaginas: ["caja", "pacientes"] }).ok).toBe(true);
    expect(decidirAccesoFacturas({ miembro: true, allowedModules: ["HOSPITAL"], hospitalPaginas: ["censo", "agenda", "pacientes"] }).ok).toBe(false);
    expect(decidirAccesoFacturas({ miembro: true, allowedModules: ["CONSTRUCCION"], hospitalPaginas: [] }).ok).toBe(false);
  });
  it("el enlace firmado sólo sirve para su reporte y formato, y caduca", () => {
    const t = firmarDescarga("r1", "xlsx", 1_000);
    expect(verificarDescarga("r1", "xlsx", t, 2_000)).toBe(true);
    expect(verificarDescarga("r1", "zip", t, 2_000)).toBe(false);
    expect(verificarDescarga("r2", "xlsx", t, 2_000)).toBe(false);
    expect(verificarDescarga("r1", "xlsx", t, 1_000 + 25 * 3600_000)).toBe(false);
  });
});
