import { describe, it, expect } from "vitest";
import { parseRepresentacion } from "./representacion";

const INGRESO = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Serie="F" Folio="6"
  Fecha="2026-06-03T10:00:00" FormaPago="03" MetodoPago="PUE" Moneda="MXN" TipoCambio="1"
  SubTotal="166666.67" Total="193333.34" TotalImpuestosTrasladados="26666.67"
  LugarExpedicion="11000" NoCertificado="30001000000500003416" Sello="ABCSELLOCFD12345678"
  TipoDeComprobante="I">
  <cfdi:Emisor Rfc="BII1312043A1" Nombre="BULDING INNOVATIVE IDEAS" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="ACI0307141W9" Nombre="ADET CONSTRUCCION INMOBILIARIA"
    DomicilioFiscalReceptor="11000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="80141600" Cantidad="1" ClaveUnidad="E48" Unidad="Unidad de servicio"
      Descripcion="Servicios de construcción" ValorUnitario="166666.67" Importe="166666.67" ObjetoImp="02"/>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="26666.67">
    <cfdi:Traslados>
      <cfdi:Traslado Base="166666.67" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="26666.67"/>
    </cfdi:Traslados>
  </cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1"
      UUID="11111111-2222-3333-4444-555555555555" FechaTimbrado="2026-06-03T10:01:00"
      RfcProvCertif="SAT970701NN3" SelloCFD="ABCSELLOCFD12345678" NoCertificadoSAT="00001000000400000001"
      SelloSAT="XYZSELLOSAT87654321"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

const NOMINA = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Fecha="2026-06-11T08:00:00"
  FormaPago="99" MetodoPago="PUE" Moneda="MXN" SubTotal="4725.60" Total="4725.60" TipoDeComprobante="N"
  Sello="NOMSELLOCFD000111">
  <cfdi:Emisor Rfc="BII1312043A1" Nombre="BULDING INNOVATIVE IDEAS" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="COBK941214676" Nombre="KATIA FABIOLA CORDERO BERNARDINO" UsoCFDI="CN01"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="84111505" Cantidad="1" ClaveUnidad="ACT" Descripcion="Pago de nómina"
      ValorUnitario="4725.60" Importe="4725.60"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>
    <nomina12:Nomina xmlns:nomina12="http://www.sat.gob.mx/nomina12" Version="1.2" TipoNomina="O"
      FechaPago="2026-06-11" FechaInicialPago="2026-06-01" FechaFinalPago="2026-06-15" NumDiasPagados="15"
      TotalPercepciones="4725.60" TotalDeducciones="0.00">
      <nomina12:Emisor RegistroPatronal="A1234567890"/>
      <nomina12:Receptor Curp="COBK941214MDFRRT01" NumSeguridadSocial="12345678901"
        TipoContrato="01" TipoRegimen="02" NumEmpleado="42" Puesto="Auxiliar"
        PeriodicidadPago="04" SalarioDiarioIntegrado="315.04"/>
      <nomina12:Percepciones TotalSueldos="4725.60" TotalGravado="4725.60" TotalExento="0.00">
        <nomina12:Percepcion TipoPercepcion="001" Clave="001" Concepto="Sueldos" ImporteGravado="4725.60" ImporteExento="0.00"/>
      </nomina12:Percepciones>
    </nomina12:Nomina>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

const PAGO = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Fecha="2026-06-11T09:00:00"
  Moneda="XXX" SubTotal="0" Total="0" TipoDeComprobante="P">
  <cfdi:Emisor Rfc="BII1312043A1" Nombre="BULDING INNOVATIVE IDEAS" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="ACI0307141W9" Nombre="ADET CONSTRUCCION INMOBILIARIA" UsoCFDI="CP01"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="84111506" Cantidad="1" ClaveUnidad="ACT" Descripcion="Pago" ValorUnitario="0" Importe="0"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>
    <pago20:Pagos xmlns:pago20="http://www.sat.gob.mx/Pagos20" Version="2.0">
      <pago20:Pago FechaPago="2026-06-11T00:00:00" FormaDePagoP="03" MonedaP="MXN" Monto="20106.18">
        <pago20:DoctoRelacionado IdDocumento="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" Serie="F" Folio="10"
          MonedaDR="MXN" NumParcialidad="1" ImpSaldoAnt="20106.18" ImpPagado="20106.18" ImpSaldoInsoluto="0.00" ObjetoImpDR="02"/>
      </pago20:Pago>
    </pago20:Pagos>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

describe("parseRepresentacion", () => {
  it("parsea un CFDI de Ingreso con impuestos y timbre", () => {
    const r = parseRepresentacion(INGRESO);
    expect(r.tipoComprobante).toBe("I");
    expect(r.serie).toBe("F");
    expect(r.folio).toBe("6");
    expect(r.emisor.rfc).toBe("BII1312043A1");
    expect(r.receptor.rfc).toBe("ACI0307141W9");
    expect(r.subtotal).toBe(166666.67);
    expect(r.total).toBe(193333.34);
    expect(r.conceptos).toHaveLength(1);
    expect(r.conceptos[0].descripcion).toContain("construcción");
    expect(r.traslados).toHaveLength(1);
    expect(r.traslados[0].impuesto).toBe("IVA");
    expect(r.traslados[0].importe).toBeCloseTo(26666.67, 2);
    expect(r.tfd?.uuid).toBe("11111111-2222-3333-4444-555555555555");
    // Cadena original del TFD y URL de verificación armadas.
    expect(r.cadenaOriginalTFD).toContain("11111111-2222-3333-4444-555555555555");
    expect(r.verificacionUrl).toContain("verificacfdi.facturaelectronica.sat.gob.mx");
    expect(r.verificacionUrl).toContain("re=BII1312043A1");
  });

  it("parsea un recibo de Nómina (percepciones, datos del empleado)", () => {
    const r = parseRepresentacion(NOMINA);
    expect(r.tipoComprobante).toBe("N");
    expect(r.nomina).not.toBeNull();
    expect(r.nomina?.tipoNomina).toBe("O");
    expect(r.nomina?.numDiasPagados).toBe(15);
    expect(r.nomina?.curp).toBe("COBK941214MDFRRT01");
    expect(r.nomina?.tipoRegimen).toBe("02");
    expect(r.nomina?.percepciones).toHaveLength(1);
    expect(r.nomina?.percepciones[0].gravado).toBeCloseTo(4725.6, 2);
    expect(r.nomina?.totalPercepciones).toBeCloseTo(4725.6, 2);
  });

  it("parsea un complemento de Pago (REP) con documento relacionado", () => {
    const r = parseRepresentacion(PAGO);
    expect(r.tipoComprobante).toBe("P");
    expect(r.pagos).not.toBeNull();
    expect(r.pagos).toHaveLength(1);
    expect(r.pagos?.[0].monto).toBeCloseTo(20106.18, 2);
    expect(r.pagos?.[0].doctos).toHaveLength(1);
    expect(r.pagos?.[0].doctos[0].idDocumento).toBe("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
    expect(r.pagos?.[0].doctos[0].impPagado).toBeCloseTo(20106.18, 2);
  });
});
