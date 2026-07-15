import { describe, it, expect } from "vitest";
import {
  construirExpresion,
  datosConsultaDesdeXml,
  esCancelado,
  parseEstadoConsulta,
} from "./vigencia-cfdi";

const XML = `<?xml version="1.0" encoding="utf-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Serie="A" Folio="24"
  Fecha="2026-01-27T12:00:00" SubTotal="367399.92" Total="426183.91" Moneda="MXN" TipoDeComprobante="I">
  <cfdi:Emisor Rfc="CBA170606FQ8" Nombre="CONSTRUCTORA BARTIZ-VERT SA DE CV" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="FUA851220CF0" Nombre="FUNDACION UNIVERSIDAD DE LAS AMERICAS PUEBLA" UsoCFDI="G03" DomicilioFiscalReceptor="72810" RegimenFiscalReceptor="603"/>
</cfdi:Comprobante>`;

describe("datosConsultaDesdeXml", () => {
  it("extrae emisor, receptor y Total VERBATIM del CFDI 4.0", () => {
    const d = datosConsultaDesdeXml(XML, "35394DF4-5E48-43D7-A548-9FFBC7DB30AC");
    expect(d).toEqual({
      re: "CBA170606FQ8",
      rr: "FUA851220CF0",
      tt: "426183.91",
      id: "35394DF4-5E48-43D7-A548-9FFBC7DB30AC",
    });
  });

  it("tolera prefijos de namespace distintos y atributos en otro orden", () => {
    const xml = `<x:Comprobante Total="100.00" xmlns:x="ns"><x:Emisor Nombre="A" Rfc="AAA010101AAA"/><x:Receptor UsoCFDI="G03" Rfc="BBB010101BBB"/></x:Comprobante>`;
    const d = datosConsultaDesdeXml(xml, "U");
    expect(d?.re).toBe("AAA010101AAA");
    expect(d?.rr).toBe("BBB010101BBB");
    expect(d?.tt).toBe("100.00");
  });

  it("devuelve null si falta cualquiera de los tres datos", () => {
    expect(datosConsultaDesdeXml(`<Comprobante Total="1"/>`, "U")).toBeNull();
  });
});

describe("construirExpresion", () => {
  it("arma la expresión impresa que espera el servicio", () => {
    expect(construirExpresion({ re: "A", rr: "B", tt: "426183.91", id: "UUID-1" })).toBe(
      "?re=A&rr=B&tt=426183.91&id=UUID-1",
    );
  });
});

describe("parseEstadoConsulta / esCancelado", () => {
  const soap = (estado: string) => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body><ConsultaResponse xmlns="http://tempuri.org/">
    <ConsultaResult xmlns:a="http://schemas.datacontract.org/2004/07/Sat.Cfdi" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
      <a:CodigoEstatus>S - Comprobante obtenido satisfactoriamente.</a:CodigoEstatus>
      <a:EsCancelable>Cancelable con aceptación</a:EsCancelable>
      <a:Estado>${estado}</a:Estado>
      <a:EstatusCancelacion>Cancelado con aceptación</a:EstatusCancelacion>
    </ConsultaResult>
  </ConsultaResponse></s:Body>
</s:Envelope>`;

  it("lee Estado/EsCancelable/EstatusCancelacion con prefijo de namespace variable", () => {
    const e = parseEstadoConsulta(soap("Cancelado"));
    expect(e).toEqual({
      estado: "Cancelado",
      esCancelable: "Cancelable con aceptación",
      estatusCancelacion: "Cancelado con aceptación",
    });
    expect(esCancelado(e!)).toBe(true);
  });

  it("un CFDI vigente no se marca", () => {
    const e = parseEstadoConsulta(soap("Vigente"));
    expect(esCancelado(e!)).toBe(false);
  });

  it("respuesta sin Estado → null (el cron la cuenta como error, no toca la factura)", () => {
    expect(parseEstadoConsulta("<s:Envelope><s:Body/></s:Envelope>")).toBeNull();
  });
});
