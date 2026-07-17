import { describe, it, expect } from "vitest";
import { emisorNombreDesdeXml, sinRegimenSocietario } from "./nombre-fiscal";

const XML = `<?xml version="1.0"?><cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" TipoDeComprobante="I">
<cfdi:Emisor Rfc="RHC190321AB1" Nombre="REYES HUERTA CHOLULA" RegimenFiscal="601"/>
<cfdi:Receptor Rfc="ZIO190321JI6" Nombre="ZIONX" DomicilioFiscalReceptor="72810" UsoCFDI="G03"/>
</cfdi:Comprobante>`;

describe("emisorNombreDesdeXml", () => {
  it("extrae el Nombre EXACTO del Emisor cuando el RFC coincide", () => {
    expect(emisorNombreDesdeXml(XML, "RHC190321AB1")).toBe("REYES HUERTA CHOLULA");
  });

  it("RFC distinto (CFDI recibido — el emisor es un tercero) → null", () => {
    expect(emisorNombreDesdeXml(XML, "ZIO190321JI6")).toBe(null);
  });

  it("decodifica entidades XML (& en razones sociales)", () => {
    const conAmp = XML.replace('Nombre="REYES HUERTA CHOLULA"', 'Nombre="PEREZ &amp; GARCIA"');
    expect(emisorNombreDesdeXml(conAmp, "RHC190321AB1")).toBe("PEREZ & GARCIA");
  });

  it("sin nodo Emisor o Nombre vacío → null", () => {
    expect(emisorNombreDesdeXml("<cfdi:Comprobante/>", "RHC190321AB1")).toBe(null);
    const vacio = XML.replace('Nombre="REYES HUERTA CHOLULA"', 'Nombre=""');
    expect(emisorNombreDesdeXml(vacio, "RHC190321AB1")).toBe(null);
  });
});

describe("sinRegimenSocietario", () => {
  it("recorta los sufijos comunes (el caso real del timbrado rechazado)", () => {
    expect(sinRegimenSocietario("REYES HUERTA CHOLULA SA DE CV")).toBe("REYES HUERTA CHOLULA");
    expect(sinRegimenSocietario("BAOBAB JQM SAPI DE CV")).toBe("BAOBAB JQM");
    expect(sinRegimenSocietario("CONSTRUCTORA BARTIZ-VERT, S.A. DE C.V.")).toBe("CONSTRUCTORA BARTIZ-VERT");
  });

  it("tolera puntos y particiones distintas del sufijo", () => {
    expect(sinRegimenSocietario("Soluciones de Movilidad Poblana S.A.P.I. de C.V.")).toBe(
      "Soluciones de Movilidad Poblana"
    );
    expect(sinRegimenSocietario("MI EMPRESA S. DE R.L. DE C.V.")).toBe("MI EMPRESA");
  });

  it("personas físicas y nombres sin sufijo quedan intactos", () => {
    expect(sinRegimenSocietario("Minerva Esther Huerta Olivares")).toBe("Minerva Esther Huerta Olivares");
    expect(sinRegimenSocietario("ZIONX")).toBe("ZIONX");
  });

  it("nunca deja el nombre vacío (nombre que ES sólo el sufijo)", () => {
    expect(sinRegimenSocietario("SA DE CV")).toBe("SA DE CV");
  });
});
