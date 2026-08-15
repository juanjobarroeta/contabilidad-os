import { describe, expect, it } from "vitest";
import {
  faltaIdentidadParaFacturar,
  identidadDesdeCfdi,
  parcheCliente,
  regimenParaAlta,
  REGIMEN_PLACEHOLDER,
} from "./identidad-receptor";

const cfdi = {
  rfcReceptor: "AAA010101AAA",
  nombreReceptor: "CLIENTE SA DE CV",
  domicilioFiscalReceptor: "72000",
  regimenFiscalReceptor: "601",
};

describe("identidadDesdeCfdi", () => {
  it("en una EMITIDA toma CP y régimen del receptor (datos exactos del padrón)", () => {
    expect(identidadDesdeCfdi(cfdi, true)).toEqual({ codigoPostal: "72000", regimenFiscal: "601" });
  });

  it("en una RECIBIDA no inventa CP: el nodo Emisor no lo trae", () => {
    // LugarExpedicion es el lugar de expedición, no el domicilio fiscal del
    // proveedor. Un CP adivinado rompe el timbrado igual que uno ausente.
    expect(identidadDesdeCfdi(cfdi, false)).toEqual({ codigoPostal: null, regimenFiscal: null });
  });

  it("descarta un CP mal formado en vez de guardarlo", () => {
    expect(identidadDesdeCfdi({ ...cfdi, domicilioFiscalReceptor: "7200" }, true).codigoPostal).toBeNull();
    expect(identidadDesdeCfdi({ ...cfdi, domicilioFiscalReceptor: "ABCDE" }, true).codigoPostal).toBeNull();
    expect(identidadDesdeCfdi({ ...cfdi, domicilioFiscalReceptor: null }, true).codigoPostal).toBeNull();
  });

  it("recorta espacios alrededor", () => {
    const r = identidadDesdeCfdi({ ...cfdi, domicilioFiscalReceptor: " 72000 ", regimenFiscalReceptor: " 601 " }, true);
    expect(r).toEqual({ codigoPostal: "72000", regimenFiscal: "601" });
  });

  it("un CFDI 3.3 (sin esos atributos) no revienta", () => {
    expect(identidadDesdeCfdi({ rfcReceptor: "AAA010101AAA" }, true)).toEqual({
      codigoPostal: null,
      regimenFiscal: null,
    });
  });
});

describe("regimenParaAlta", () => {
  it("emitida: el régimen del receptor", () => {
    expect(regimenParaAlta({ esEmitida: true, regimenFiscalReceptor: "601", regimenEmisor: "612" })).toBe("601");
  });

  it("recibida: el del emisor, que es el régimen real del proveedor", () => {
    expect(regimenParaAlta({ esEmitida: false, regimenFiscalReceptor: "601", regimenEmisor: "612" })).toBe("612");
  });

  it("sin dato cae al relleno — pero sólo entonces", () => {
    expect(regimenParaAlta({ esEmitida: true })).toBe(REGIMEN_PLACEHOLDER);
    expect(regimenParaAlta({ esEmitida: true, regimenFiscalReceptor: "  " })).toBe(REGIMEN_PLACEHOLDER);
  });
});

describe("parcheCliente", () => {
  it("rellena los huecos de un cliente creado por el importador", () => {
    // El caso real: alta automática con régimen 616 y sin CP.
    const p = parcheCliente(
      { codigoPostal: null, regimenFiscal: REGIMEN_PLACEHOLDER },
      { codigoPostal: "72000", regimenFiscal: "601" }
    );
    expect(p).toEqual({ codigoPostal: "72000", regimenFiscal: "601" });
  });

  it("NUNCA pisa un dato capturado a mano", () => {
    // El contador pudo corregirlo con la constancia enfrente; su dato vale más
    // que el de un CFDI viejo.
    const p = parcheCliente(
      { codigoPostal: "11560", regimenFiscal: "612" },
      { codigoPostal: "72000", regimenFiscal: "601" }
    );
    expect(p).toEqual({});
  });

  it("trata el relleno 616 como hueco, no como decisión", () => {
    const p = parcheCliente({ codigoPostal: "11560", regimenFiscal: "616" }, { codigoPostal: null, regimenFiscal: "601" });
    expect(p).toEqual({ regimenFiscal: "601" });
  });

  it("no reemplaza un relleno por otro relleno", () => {
    const p = parcheCliente({ codigoPostal: null, regimenFiscal: "616" }, { codigoPostal: null, regimenFiscal: "616" });
    expect(p).toEqual({});
  });

  it("sin nada que aportar devuelve {} (no se escribe en balde)", () => {
    expect(parcheCliente({ codigoPostal: null, regimenFiscal: null }, { codigoPostal: null, regimenFiscal: null })).toEqual({});
  });

  it("puede rellenar sólo uno de los dos", () => {
    expect(parcheCliente({ codigoPostal: null, regimenFiscal: "601" }, { codigoPostal: "72000", regimenFiscal: "601" }))
      .toEqual({ codigoPostal: "72000" });
  });
});

describe("faltaIdentidadParaFacturar", () => {
  it("completo = se puede facturar", () => {
    expect(faltaIdentidadParaFacturar({ codigoPostal: "72000", regimenFiscal: "601" })).toBe(false);
  });

  it("sin CP no se puede: el SAT valida RFC + Nombre + CP como tripleta", () => {
    expect(faltaIdentidadParaFacturar({ codigoPostal: null, regimenFiscal: "601" })).toBe(true);
  });

  it("con el relleno 616 tampoco: no es un régimen real", () => {
    expect(faltaIdentidadParaFacturar({ codigoPostal: "72000", regimenFiscal: "616" })).toBe(true);
  });
});
