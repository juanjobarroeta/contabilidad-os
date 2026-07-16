import { describe, it, expect } from "vitest";
import { receptorDesdeXmlNomina } from "./receptor-xml";

const XML = `<?xml version="1.0"?><cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" TipoDeComprobante="N">
<cfdi:Emisor Rfc="ZIO190321JI6" Nombre="ZIONX SA DE CV" RegimenFiscal="601"/>
<cfdi:Receptor Rfc="MIGP920407KQ9" Nombre="PEDRO DAMIAN MIJANGOS GARCIA" DomicilioFiscalReceptor="72810" RegimenFiscalReceptor="605" UsoCFDI="CN01"/>
</cfdi:Comprobante>`;

describe("receptorDesdeXmlNomina", () => {
  it("extrae el nombre y CP EXACTOS del Receptor de un recibo timbrado", () => {
    expect(receptorDesdeXmlNomina(XML, "MIGP920407KQ9")).toEqual({
      nombre: "PEDRO DAMIAN MIJANGOS GARCIA",
      codigoPostal: "72810",
    });
  });

  it("RFC en otra caja también cuadra", () => {
    expect(receptorDesdeXmlNomina(XML, "migp920407kq9")?.codigoPostal).toBe("72810");
  });

  it("si el Receptor es de OTRO RFC, no devuelve nada (el filtro del llamador pudo fallar)", () => {
    expect(receptorDesdeXmlNomina(XML, "SAIK951113MY6")).toBeNull();
  });

  it("CP no numérico o ausente → null en codigoPostal, sin inventar", () => {
    const sinCp = XML.replace(' DomicilioFiscalReceptor="72810"', "");
    expect(receptorDesdeXmlNomina(sinCp, "MIGP920407KQ9")).toEqual({
      nombre: "PEDRO DAMIAN MIJANGOS GARCIA",
      codigoPostal: null,
    });
  });

  it("sin nodo Receptor → null", () => {
    expect(receptorDesdeXmlNomina("<cfdi:Comprobante/>", "MIGP920407KQ9")).toBeNull();
  });
});
