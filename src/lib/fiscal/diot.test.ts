import { describe, it, expect } from "vitest";
import {
  archivoDiot2025,
  archivoDiotLegacy,
  lineaDiot2025,
  lineaDiotLegacy,
  CAMPOS_DIOT_2025,
  type ProveedorDiot,
} from "./diot";

// ─────────────────────────────────────────────────────────────────────────────
// Serialización de la DIOT — pruebas DORADAS contra el layout de carga masiva
// DIOT 2025 (instructivo SAT Enero 2025, 54 campos, pesos enteros) y el layout
// legacy DEM (15 campos, dos decimales). Ver docs/DIOT-2025.md.
// ─────────────────────────────────────────────────────────────────────────────

const nacional: ProveedorDiot = {
  rfc: "AAA010101AAA",
  razonSocial: "PROVEEDOR NACIONAL SA DE CV",
  tipoTercero: "04",
  valorActosGravados16: 10000.4, // → 10000 en 2025 (enteros), 10000.40 legacy
  ivaTrasladadoPagado16: 1600.06,
  valorActosGravados0: 500,
  valorActosExentos: 250.5,
  ivaNoAcreditable: 0,
  ivaRetenido: 106.67,
};

describe("lineaDiot2025 (layout de carga masiva, ejercicios 2025+)", () => {
  it("proveedor nacional: línea dorada de 54 campos", () => {
    // Campos (1-index): 1 tipo tercero, 2 tipo operación (85 Otros),
    // 3 RFC, 4-7 vacíos (sólo extranjero), 12 base 16%, 22 IVA acreditable,
    // 48 IVA retenido, 50 exentos, 51 tasa 0%, 54 manifiesto 01.
    expect(lineaDiot2025(nacional)).toBe(
      "04|85|AAA010101AAA|||||" + // 1-7 datos del tercero
        "0|0|0|0|10000|0|0|0|0|0|" + // 8-17 valor de actos (12 = base 16%)
        "0|0|0|0|1600|0|0|0|0|0|" + // 18-27 IVA acreditable (22 = excl. gravadas 16%)
        "0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|" + // 28-47 IVA no acreditable
        "107|0|251|500|0|0|01" // 48-54 datos adicionales + manifiesto
    );
  });

  it("cada línea tiene exactamente 54 campos", () => {
    expect(lineaDiot2025(nacional).split("|")).toHaveLength(CAMPOS_DIOT_2025);
  });

  it("proveedor extranjero: operación 07, id fiscal/nombre, bases en importación de intangibles", () => {
    const extranjero: ProveedorDiot = {
      rfc: "US123456789", // < 12 posiciones: identificador extranjero real
      razonSocial: "FOREIGN SOFTWARE INC",
      tipoTercero: "05",
      valorActosGravados16: 2000,
      ivaTrasladadoPagado16: 320,
      valorActosGravados0: 0,
      valorActosExentos: 100,
      ivaNoAcreditable: 0,
      ivaRetenido: 0,
    };
    expect(lineaDiot2025(extranjero)).toBe(
      "05|07||US123456789|FOREIGN SOFTWARE INC|||" + // RFC vacío; campo 4 id fiscal, 5 nombre
        "0|0|0|0|0|0|0|0|2000|0|" + // 16 = importación de intangibles/servicios 16%
        "0|0|0|0|0|0|0|0|320|0|" + // 26 = IVA acreditable importación intangibles
        "0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|" +
        "0|100|0|0|0|0|01" // 49 = importación exenta
    );
  });

  it("extranjero con RFC genérico XEXX: sin RFC y sin id fiscal (a completar en la plataforma)", () => {
    const generico: ProveedorDiot = {
      rfc: "XEXX010101000",
      razonSocial: "PROVEEDOR EXTRANJERO",
      tipoTercero: "05",
      valorActosGravados16: 100,
      ivaTrasladadoPagado16: 16,
      valorActosGravados0: 0,
      valorActosExentos: 0,
      ivaNoAcreditable: 0,
      ivaRetenido: 0,
    };
    const campos = lineaDiot2025(generico).split("|");
    expect(campos[2]).toBe(""); // RFC vacío (opcional para extranjero)
    expect(campos[3]).toBe(""); // id fiscal desconocido
    expect(campos[4]).toBe("PROVEEDOR EXTRANJERO");
  });

  it("proveedor global: 15|87 con RFC XAXX010101000", () => {
    const global: ProveedorDiot = {
      rfc: "XAXX010101000",
      razonSocial: "PUBLICO EN GENERAL",
      tipoTercero: "15",
      valorActosGravados16: 300,
      ivaTrasladadoPagado16: 48,
      valorActosGravados0: 0,
      valorActosExentos: 0,
      ivaNoAcreditable: 0,
      ivaRetenido: 0,
    };
    const campos = lineaDiot2025(global).split("|");
    expect(campos[0]).toBe("15");
    expect(campos[1]).toBe("87");
    expect(campos[2]).toBe("XAXX010101000");
    expect(campos[11]).toBe("300");
    expect(campos[21]).toBe("48");
  });

  it("IVA 100% no acreditable (69-B / bandera): campo 37 y manifiesto 02", () => {
    const bloqueado: ProveedorDiot = {
      ...nacional,
      ivaTrasladadoPagado16: 0,
      ivaNoAcreditable: 1600.06,
    };
    const campos = lineaDiot2025(bloqueado).split("|");
    expect(campos[21]).toBe("0"); // IVA acreditable
    expect(campos[36]).toBe("1600"); // no acreditable "no cumple requisitos" 16%
    expect(campos[53]).toBe("02"); // no se dieron efectos fiscales
  });

  it("archivoDiot2025: CRLF sin encabezado ni salto final", () => {
    const contenido = archivoDiot2025([nacional, nacional]);
    expect(contenido.split("\r\n")).toHaveLength(2);
    expect(contenido.endsWith("\r\n")).toBe(false);
  });
});

describe("lineaDiotLegacy (layout DEM de 15 campos — sin cambios de comportamiento)", () => {
  it("proveedor nacional: línea dorada de 15 campos con dos decimales", () => {
    expect(lineaDiotLegacy(nacional)).toBe(
      "04|AAA010101AAA|PROVEEDOR NACIONAL SA DE CV|||" +
        "10000.40|0|500.00|250.50|106.67|1600.06|0|0|0.00|0"
    );
  });

  it("archivoDiotLegacy une con CRLF", () => {
    expect(archivoDiotLegacy([nacional, nacional]).split("\r\n")).toHaveLength(2);
  });
});
