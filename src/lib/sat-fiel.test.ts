import { describe, it, expect } from "vitest";
import { parseCfdiXml } from "./sat-fiel";

// CFDI 4.0 de nómina (tipo "N") de ASIMILADOS A SALARIOS: el emisor (un tercero)
// le paga a JUAN JOSE BARROETA bajo régimen 09 (asimilados honorarios) y le
// retiene ISR. Antes el import descartaba todo el complemento de nómina.
const NOMINA_ASIMILADOS = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:nomina12="http://www.sat.gob.mx/nomina12" Version="4.0" Fecha="2026-06-15T12:00:00" TipoDeComprobante="N" SubTotal="400000.00" Descuento="80000.00" Total="320000.00" Moneda="MXN">
  <cfdi:Emisor Rfc="EPF2502255C8" Nombre="ENLACE PROYECTOS FE" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="BAJJ800101AAA" Nombre="JUAN JOSE BARROETA" UsoCFDI="CN01"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="84111505" ClaveUnidad="ACT" Cantidad="1" Descripcion="Pago de nomina" ValorUnitario="400000.00" Importe="400000.00"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>
    <nomina12:Nomina Version="1.2" TipoNomina="O" FechaPago="2026-06-15" TotalPercepciones="400000.00" TotalDeducciones="80000.00" TotalOtrosPagos="0">
      <nomina12:Emisor RegistroPatronal="A1234567890"/>
      <nomina12:Receptor Curp="BAJJ800101HDFRRN00" TipoRegimen="09" NumEmpleado="1"/>
      <nomina12:Percepciones TotalGravado="400000.00" TotalExento="0"/>
      <nomina12:Deducciones TotalImpuestosRetenidos="80000.00">
        <nomina12:Deduccion TipoDeduccion="002" Clave="002" Concepto="ISR" Importe="80000.00"/>
      </nomina12:Deducciones>
    </nomina12:Nomina>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="abcdef01-2345-6789-abcd-ef0123456789"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

const INGRESO = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Fecha="2026-06-15T12:00:00" TipoDeComprobante="I" SubTotal="100.00" Total="116.00"><cfdi:Emisor Rfc="AAA010101AAA" RegimenFiscal="601"/><cfdi:Receptor Rfc="BBB010101BBB" UsoCFDI="G03"/></cfdi:Comprobante>`;

describe("parseCfdiXml — complemento de nómina", () => {
  it("extrae régimen asimilados, tipo de nómina e ISR retenido", () => {
    const r = parseCfdiXml(NOMINA_ASIMILADOS);
    expect(r.tipo).toBe("N");
    expect(r.nomina).not.toBeNull();
    expect(r.nomina?.tipoRegimen).toBe("09"); // asimilados honorarios
    expect(r.nomina?.tipoNomina).toBe("O");
    expect(r.nomina?.isrRetenido).toBeCloseTo(80000, 2);
    expect(r.nomina?.totalPercepciones).toBeCloseTo(400000, 2);
    expect(r.nomina?.totalDeducciones).toBeCloseTo(80000, 2);
    // El régimen del Receptor del complemento, no el cfdi:Receptor (sin TipoRegimen).
    expect(r.uuid).toBe("ABCDEF01-2345-6789-ABCD-EF0123456789");
  });

  it("no produce datos de nómina para un CFDI de ingreso", () => {
    const r = parseCfdiXml(INGRESO);
    expect(r.tipo).toBe("I");
    expect(r.nomina).toBeNull();
  });
});
