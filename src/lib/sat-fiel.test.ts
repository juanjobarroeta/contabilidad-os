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

// ─── CfdiRelacionados ────────────────────────────────────────────────────────
// El nodo que dice a qué otro comprobante apunta éste. El parser lo ignoraba
// por completo, así que todo lo importado del SAT llegaba sin relación y el
// neteo de notas de crédito y anticipos se tenía que adivinar.

const relacionados = (cuerpo: string) =>
  `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Fecha="2026-06-15T12:00:00" TipoDeComprobante="E" SubTotal="100.00" Total="116.00">${cuerpo}<cfdi:Emisor Rfc="AAA010101AAA" RegimenFiscal="601"/><cfdi:Receptor Rfc="BBB010101BBB" UsoCFDI="G02"/></cfdi:Comprobante>`;

describe("parseCfdiXml — CfdiRelacionados", () => {
  it("lee tipo y UUID de una nota de crédito (relación 01)", () => {
    const r = parseCfdiXml(
      relacionados(
        `<cfdi:CfdiRelacionados TipoRelacion="01"><cfdi:CfdiRelacionado UUID="11111111-2222-3333-4444-555555555555"/></cfdi:CfdiRelacionados>`,
      ),
    );
    expect(r.relacionados).toEqual([
      { tipoRelacion: "01", uuids: ["11111111-2222-3333-4444-555555555555"] },
    ]);
  });

  it("normaliza el UUID a mayúsculas, como el del timbre", () => {
    const r = parseCfdiXml(
      relacionados(
        `<cfdi:CfdiRelacionados TipoRelacion="07"><cfdi:CfdiRelacionado UUID="abcdef01-2345-6789-abcd-ef0123456789"/></cfdi:CfdiRelacionados>`,
      ),
    );
    // Sin canonizar la caja, el mismo folio fiscal escrito por dos emisores
    // distintos no empata consigo mismo y la liga se pierde.
    expect(r.relacionados[0].uuids).toEqual(["ABCDEF01-2345-6789-ABCD-EF0123456789"]);
  });

  it("conserva varios nodos y varios hijos", () => {
    // El CFDI 4.0 admite un nodo por TipoRelacion, cada uno con varios hijos:
    // una sola nota de crédito puede corregir tres facturas.
    const r = parseCfdiXml(
      relacionados(
        `<cfdi:CfdiRelacionados TipoRelacion="01"><cfdi:CfdiRelacionado UUID="AAAAAAAA-0000-0000-0000-000000000001"/><cfdi:CfdiRelacionado UUID="AAAAAAAA-0000-0000-0000-000000000002"/></cfdi:CfdiRelacionados>` +
          `<cfdi:CfdiRelacionados TipoRelacion="04"><cfdi:CfdiRelacionado UUID="BBBBBBBB-0000-0000-0000-000000000003"/></cfdi:CfdiRelacionados>`,
      ),
    );
    expect(r.relacionados).toEqual([
      {
        tipoRelacion: "01",
        uuids: ["AAAAAAAA-0000-0000-0000-000000000001", "AAAAAAAA-0000-0000-0000-000000000002"],
      },
      { tipoRelacion: "04", uuids: ["BBBBBBBB-0000-0000-0000-000000000003"] },
    ]);
  });

  it("es agnóstico al prefijo de namespace", () => {
    const r = parseCfdiXml(
      relacionados(
        `<cfdi4:CfdiRelacionados TipoRelacion="07"><cfdi4:CfdiRelacionado UUID="CCCCCCCC-0000-0000-0000-000000000004"/></cfdi4:CfdiRelacionados>`,
      ),
    );
    expect(r.relacionados[0]?.tipoRelacion).toBe("07");
  });

  it("no confunde DoctoRelacionado de un complemento de pago con una relación", () => {
    // Los dos nodos se parecen de nombre y viven en comprobantes distintos:
    // DoctoRelacionado dice qué factura PAGA un REP, no a cuál sustituye.
    const r = parseCfdiXml(
      relacionados(
        `<cfdi:Complemento><pago20:Pagos xmlns:pago20="http://www.sat.gob.mx/Pagos20"><pago20:Pago FechaPago="2026-06-15"><pago20:DoctoRelacionado IdDocumento="DDDDDDDD-0000-0000-0000-000000000005" ImpPagado="116.00"/></pago20:Pago></pago20:Pagos></cfdi:Complemento>`,
      ),
    );
    expect(r.relacionados).toEqual([]);
    expect(r.doctosRelacionados).toHaveLength(1);
  });

  it("devuelve lista vacía cuando el comprobante no trae el nodo", () => {
    expect(parseCfdiXml(INGRESO).relacionados).toEqual([]);
  });

  it("ignora un nodo sin TipoRelacion o sin hijos utilizables", () => {
    // Existe en la práctica y no debe producir una relación a medias: el
    // barrido de backfill la marcaría como intentada y seguiría.
    expect(
      parseCfdiXml(relacionados(`<cfdi:CfdiRelacionados TipoRelacion="01"></cfdi:CfdiRelacionados>`))
        .relacionados,
    ).toEqual([]);
    expect(
      parseCfdiXml(
        relacionados(
          `<cfdi:CfdiRelacionados><cfdi:CfdiRelacionado UUID="EEEEEEEE-0000-0000-0000-000000000006"/></cfdi:CfdiRelacionados>`,
        ),
      ).relacionados,
    ).toEqual([]);
  });
});
