import { describe, it, expect } from "vitest";
import { FAMILIAS, familiaDeUnidad, agruparUnidadesAmparadas, regexJs } from "./familia-vehiculo";

// El mapa se validó familia por familia contra la balanza presentada
// (CeBalanzaMes) en scripts/divergencia-ce-margom.ts. Estos tests fijan los
// casos que YA costaron dinero entender: el orden del arreglo decide.

const u = (modelo: string | null, version: string | null = null, marca: string | null = null) => ({
  modelo,
  version,
  marca,
});

describe("familiaDeUnidad()", () => {
  it("FRISON en cualquiera de sus formas → 0004", () => {
    expect(familiaDeUnidad(u("PICK UP JAC FRISON 4 PUERTAS"))).toBe("0004");
    expect(familiaDeUnidad(u("FRISON T9 AT 4X4"))).toBe("0004");
    expect(familiaDeUnidad(u("Pick Up JAC FRISON 4 puertas", "Pick Up T8, Doble Cabina"))).toBe("0004");
  });

  it("SUNRAY PASAJEROS va a PASS (0013), no a CARGO — los 454 CBU de dic-2024", () => {
    expect(familiaDeUnidad(u("SUNRAY PASAJEROS CBU"))).toBe("0013");
    expect(familiaDeUnidad(u("SUNRAY Pass by G M L", "SUNRAY Pass Smart 17 pasajeros"))).toBe("0013");
  });

  it("las variantes de SUNRAY se separan por orden: chasis, eléctrica, y cargo al final", () => {
    expect(familiaDeUnidad(u("SUNRAY Cargo by G M L", "SUNRAY Cargo Chasis, diesel"))).toBe("0026");
    expect(familiaDeUnidad(u("E-SUNRAY"))).toBe("0017");
    expect(familiaDeUnidad(u("SUNRAY Cargo", "SUNRAY Cargo Smart, diesel"))).toBe("0018");
  });

  it("K7 → TRACTO (0025), incluso pegado a otra palabra", () => {
    expect(familiaDeUnidad(u("TRACTOCAMION K7 CBU"))).toBe("0025");
    expect(familiaDeUnidad(u("K7 E6"))).toBe("0025");
  });

  it("JS y SEI son la misma familia; JAC2 no es SEI2", () => {
    expect(familiaDeUnidad(u("JS2 5 puertas", "Smart, automático"))).toBe("0008");
    expect(familiaDeUnidad(u("SEI 2 FLEX MT"))).toBe("0008");
    expect(familiaDeUnidad(u("JAC2 SMART MT"))).toBe("0019");
  });

  it("EJ7 no se confunde con J7 (frontera de palabra)", () => {
    expect(familiaDeUnidad(u("EJ7 ELECTRICO"))).toBe("0003");
    expect(familiaDeUnidad(u("J7 5 puertas", "Limited, automático"))).toBe("0006");
  });

  it("los camiones X van por longitud: X12000 antes que X200", () => {
    expect(familiaDeUnidad(u("CAMIÓN JACX12000 (CARGA)"))).toBe("0022");
    expect(familiaDeUnidad(u("GMLX200 (carga)", "GMLX200, diesel"))).toBe("0014");
  });

  it("lo que no es familia JAC/GML devuelve null (fallback del motor)", () => {
    expect(familiaDeUnidad(u("AUTOBUS MODELO ZK6126BEVGS AÑO 2026 MARCA YUTONG"))).toBeNull();
    expect(familiaDeUnidad(u("SWIFT GLX 1.2 L 4 CIL 2 WD CVT", null, "SUZUKI"))).toBeNull();
    expect(familiaDeUnidad(u(null, null, null))).toBeNull();
  });
});

describe("regexJs()", () => {
  it("traduce las fronteras de Postgres (\\m/\\M) a \\b", () => {
    expect(regexJs("\\mJ7\\M").source).toBe("\\bJ7\\b");
  });

  it("todos los patrones del mapa compilan en JS", () => {
    for (const [, , patron] of FAMILIAS) expect(() => regexJs(patron)).not.toThrow();
  });
});

describe("agruparUnidadesAmparadas()", () => {
  const unidad = (invoiceId: string, modelo: string, costoCompra = 100) => ({
    invoiceId,
    vin: `VIN-${invoiceId}`,
    marca: null,
    modelo,
    version: null,
    costoCompra,
  });

  it("una unidad por invoice: el caso dominante (1:1 en MARGOM)", () => {
    const m = agruparUnidadesAmparadas([unidad("i1", "FRISON T9 AT 4X4", 445768)]);
    expect(m.get("i1")).toEqual({ sufijo: "0004", vin: "VIN-i1", costo: 445768, precio: 0 });
  });

  it("varias unidades de la MISMA familia: suma el costo", () => {
    const m = agruparUnidadesAmparadas([
      unidad("i1", "TRACTOCAMION K7 CBU", 2_137_745),
      { ...unidad("i1", "K7 E6", 1_851_538), vin: "VIN-2" },
    ]);
    expect(m.get("i1")?.costo).toBe(2_137_745 + 1_851_538);
    expect(m.get("i1")?.sufijo).toBe("0025");
  });

  it("familias mixtas en un CFDI: se descarta (fallback, no adivinanza)", () => {
    const m = agruparUnidadesAmparadas([
      unidad("i1", "FRISON T9 AT 4X4"),
      { ...unidad("i1", "JAC2 SMART MT"), vin: "VIN-2" },
    ]);
    expect(m.has("i1")).toBe(false);
  });

  it("unidad sin familia: se descarta", () => {
    const m = agruparUnidadesAmparadas([unidad("i1", "AUTOBUS YUTONG ZK6126BEVGS")]);
    expect(m.has("i1")).toBe(false);
  });
});
