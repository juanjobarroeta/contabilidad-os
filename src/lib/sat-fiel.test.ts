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

// ─────────────────────────────────────────────────────────────────────────────
// CFDI 3.2 — el esquema anterior al catálogo (vigente hasta el 2017-11-30).
//
// Todo va en minúscula (`fecha`, `total`, `subTotal`, `rfc`) y el tipo se
// escribe con palabras. El parser buscaba sólo los capitalizados de 3.3/4.0,
// así que de un 3.2 no sacaba NADA: `fecha` salía null, el importador lo daba
// por inválido y el comprobante desaparecía sin ruido.
//
// Medido en producción (MARGOM, 2026-08): de 16 XMLs de 2017 que sí se
// descargaron, 15 no se pudieron parsear por esto.
// ─────────────────────────────────────────────────────────────────────────────

const CFDI_32 = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/3" version="3.2"
  fecha="2017-09-14T11:22:33" serie="A" folio="1234"
  formaDePago="PAGO EN UNA SOLA EXHIBICION" metodoDePago="NO IDENTIFICADO"
  subTotal="1000.00" total="1160.00" moneda="MXN"
  tipoDeComprobante="ingreso" LugarExpedicion="64000">
  <cfdi:Emisor rfc="AMA170817NK1" nombre="AUTOMOTRIZ MARGOM SA DE CV">
    <cfdi:RegimenFiscal Regimen="Regimen General de Ley Personas Morales"/>
  </cfdi:Emisor>
  <cfdi:Receptor rfc="XAXX010101000" nombre="PUBLICO EN GENERAL"/>
  <cfdi:Conceptos>
    <cfdi:Concepto cantidad="1" unidad="NO APLICA" noIdentificacion="SRV-1"
      descripcion="SERVICIO DE MANTENIMIENTO" valorUnitario="1000.00" importe="1000.00"/>
  </cfdi:Conceptos>
  <cfdi:Impuestos totalImpuestosTrasladados="160.00">
    <cfdi:Traslados>
      <cfdi:Traslado impuesto="IVA" tasa="16.00" importe="160.00"/>
    </cfdi:Traslados>
  </cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
      version="1.0" UUID="3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6a7b"
      FechaTimbrado="2017-09-14T11:23:00"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

describe("parseCfdiXml — CFDI 3.2", () => {
  it("saca folio y fecha, que es lo que decidía si el comprobante existía", () => {
    const r = parseCfdiXml(CFDI_32);
    // Sin estos dos el importador devolvía "invalido" y se perdía el CFDI.
    expect(r.uuid).toBe("3F2A1B4C-5D6E-7F80-9A1B-2C3D4E5F6A7B");
    expect(r.fecha).toBe("2017-09-14T11:22:33");
  });

  it("traduce el tipo de palabra a letra", () => {
    expect(parseCfdiXml(CFDI_32).tipo).toBe("I");
    expect(parseCfdiXml(CFDI_32.replace('tipoDeComprobante="ingreso"', 'tipoDeComprobante="egreso"')).tipo).toBe("E");
    expect(parseCfdiXml(CFDI_32.replace('tipoDeComprobante="ingreso"', 'tipoDeComprobante="traslado"')).tipo).toBe("T");
  });

  it("lee los importes que van en minúscula", () => {
    const r = parseCfdiXml(CFDI_32);
    expect(r.subtotal).toBe(1000);
    expect(r.total).toBe(1160);
  });

  it("lee emisor y receptor con `rfc`/`nombre` en minúscula", () => {
    const r = parseCfdiXml(CFDI_32);
    expect(r.rfcEmisor).toBe("AMA170817NK1");
    expect(r.nombreEmisor).toBe("AUTOMOTRIZ MARGOM SA DE CV");
    expect(r.rfcReceptor).toBe("XAXX010101000");
  });

  it("conserva los conceptos aunque no exista ClaveProdServ", () => {
    const r = parseCfdiXml(CFDI_32);
    // Antes se descartaban TODOS por `if (!cps) continue`: quedaba una factura
    // con total y sin una sola línea.
    expect(r.items).toHaveLength(1);
    expect(r.items[0].descripcion).toBe("SERVICIO DE MANTENIMIENTO");
    expect(r.items[0].importe).toBe(1000);
    // «No existe en el catálogo» — decir que no hay clave, no inventar una.
    expect(r.items[0].claveProdServ).toBe("01010101");
  });

  it("desglosa el IVA identificado por nombre y normaliza la tasa a tanto por uno", () => {
    const r = parseCfdiXml(CFDI_32);
    expect(r.taxes).toHaveLength(1);
    expect(r.taxes[0].tipo).toBe("IVA");
    expect(r.taxes[0].importe).toBe(160);
    // 3.2 escribía "16.00" (porcentaje); 3.3/4.0 escriben "0.160000".
    expect(r.taxes[0].tasa).toBeCloseTo(0.16, 6);
    expect(r.ivaTotal).toBe(160);
  });

  it("NO guarda el régimen de 3.2: es texto libre, no una clave", () => {
    // «Regimen General de Ley Personas Morales» donde va una clave de tres
    // dígitos es peor que no guardar nada.
    expect(parseCfdiXml(CFDI_32).regimenEmisor).toBeNull();
  });

  it("no le pone forma ni método de pago inventados", () => {
    const r = parseCfdiXml(CFDI_32);
    // 3.2 los traía como texto libre («PAGO EN UNA SOLA EXHIBICION»), no como
    // clave del catálogo: se queda el default de «por definir».
    expect(r.formaPago).toBe("99");
    expect(r.metodoPago).toBe("PUE");
  });

  it("reconoce la nómina de 3.2, que viajaba como complemento sobre un egreso", () => {
    const nomina32 = CFDI_32
      .replace('tipoDeComprobante="ingreso"', 'tipoDeComprobante="egreso"')
      .replace("</cfdi:Complemento>", `<nomina:Nomina xmlns:nomina="http://www.sat.gob.mx/nomina" TipoNomina="O"/></cfdi:Complemento>`);
    // Si se quedara en "E" entraría como gasto y la nómina histórica no lo vería.
    expect(parseCfdiXml(nomina32).tipo).toBe("N");
  });

  it("no toca el camino de 3.3/4.0", () => {
    const v40 = CFDI_32
      .replace('version="3.2"', 'Version="4.0"')
      .replace('fecha="2017-09-14T11:22:33"', 'Fecha="2024-09-14T11:22:33"')
      .replace('subTotal="1000.00"', 'SubTotal="1000.00"')
      .replace('total="1160.00"', 'Total="1160.00"')
      .replace('tipoDeComprobante="ingreso"', 'TipoDeComprobante="I"')
      .replace('rfc="AMA170817NK1" nombre="AUTOMOTRIZ MARGOM SA DE CV"', 'Rfc="AMA170817NK1" Nombre="AUTOMOTRIZ MARGOM SA DE CV"')
      .replace('<cfdi:Concepto cantidad="1" unidad="NO APLICA"', '<cfdi:Concepto ClaveProdServ="78101800" Cantidad="1" Unidad="NO APLICA"')
      .replace('descripcion="SERVICIO DE MANTENIMIENTO" valorUnitario="1000.00" importe="1000.00"', 'Descripcion="SERVICIO DE MANTENIMIENTO" ValorUnitario="1000.00" Importe="1000.00"')
      .replace('<cfdi:Traslado impuesto="IVA" tasa="16.00" importe="160.00"/>', '<cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>');
    const r = parseCfdiXml(v40);
    expect(r.tipo).toBe("I");
    expect(r.fecha).toBe("2024-09-14T11:22:33");
    expect(r.items[0].claveProdServ).toBe("78101800");
    expect(r.taxes[0].tasa).toBeCloseTo(0.16, 6);
    expect(r.taxes[0].base).toBe(1000);
  });
});
