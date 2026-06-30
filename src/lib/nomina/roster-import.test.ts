import { describe, it, expect } from "vitest";
import {
  parseComplementoNomina,
  clasificarEmpleado,
  type ReciboEvento,
} from "./roster-import";

// ─── Fixtures de CFDI de nómina 1.2 ──────────────────────────────────────────

// Recibo ORDINARIO típico: la empresa (emisor) le paga a su trabajador.
const NOMINA_ORDINARIA = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:nomina12="http://www.sat.gob.mx/nomina12" Version="4.0" Fecha="2026-06-15T12:00:00" TipoDeComprobante="N" SubTotal="7500.00" Descuento="900.00" Total="6600.00" Moneda="MXN">
  <cfdi:Emisor Rfc="EPF2502255C8" Nombre="ENLACE PROYECTOS FE" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="MARP850101AAA" Nombre="MARIA PEREZ RAMIREZ" UsoCFDI="CN01"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="84111505" ClaveUnidad="ACT" Cantidad="1" Descripcion="Pago de nomina" ValorUnitario="7500.00" Importe="7500.00"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>
    <nomina12:Nomina Version="1.2" TipoNomina="O" FechaPago="2026-06-15" FechaInicialPago="2026-06-01" FechaFinalPago="2026-06-15" NumDiasPagados="15" TotalPercepciones="7500.00" TotalDeducciones="900.00">
      <nomina12:Emisor RegistroPatronal="A1234567890"/>
      <nomina12:Receptor Curp="MARP850101MDFRRR05" NumSeguridadSocial="12345678901" FechaInicioRelLaboral="2022-03-01" TipoContrato="01" TipoRegimen="02" NumEmpleado="7" Departamento="Operaciones" Puesto="Analista" RiesgoPuesto="2" PeriodicidadPago="04" SalarioBaseCotApor="520.55" SalarioDiarioIntegrado="545.00"/>
      <nomina12:Percepciones TotalSueldos="7500.00" TotalGravado="7500.00" TotalExento="0">
        <nomina12:Percepcion TipoPercepcion="001" Clave="001" Concepto="Sueldo" ImporteGravado="7500.00" ImporteExento="0"/>
      </nomina12:Percepciones>
    </nomina12:Nomina>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="11111111-1111-1111-1111-111111111111"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

// Finiquito: incluye una percepción de separación/indemnización (025).
const NOMINA_FINIQUITO = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:nomina12="http://www.sat.gob.mx/nomina12" Version="4.0" Fecha="2026-05-20T12:00:00" TipoDeComprobante="N" SubTotal="30000.00" Total="30000.00" Moneda="MXN">
  <cfdi:Emisor Rfc="EPF2502255C8" Nombre="ENLACE PROYECTOS FE" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="GOLC900202BBB" Nombre="CARLOS LOPEZ GOMEZ" UsoCFDI="CN01"/>
  <cfdi:Complemento>
    <nomina12:Nomina Version="1.2" TipoNomina="E" FechaPago="2026-05-20" TotalPercepciones="30000.00" TotalDeducciones="0">
      <nomina12:Receptor Curp="GOLC900202HDFMPR08" NumSeguridadSocial="98765432109" FechaInicioRelLaboral="2020-01-15" TipoContrato="01" TipoRegimen="02" PeriodicidadPago="04" SalarioBaseCotApor="600.00" SalarioDiarioIntegrado="630.00"/>
      <nomina12:Percepciones TotalSeparacionIndemnizacion="30000.00" TotalGravado="20000.00" TotalExento="10000.00">
        <nomina12:Percepcion TipoPercepcion="025" Clave="025" Concepto="Indemnizacion" ImporteGravado="20000.00" ImporteExento="10000.00">
          <nomina12:SeparacionIndemnizacion TotalPagado="30000.00" NumAniosServicio="6" UltimoSueldoMensOrd="18000.00" IngresoAcumulable="20000.00" IngresoNoAcumulable="10000.00"/>
        </nomina12:Percepcion>
      </nomina12:Percepciones>
    </nomina12:Nomina>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="22222222-2222-2222-2222-222222222222"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

const INGRESO = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Fecha="2026-06-15T12:00:00" TipoDeComprobante="I" SubTotal="100.00" Total="116.00"><cfdi:Emisor Rfc="AAA010101AAA" RegimenFiscal="601"/><cfdi:Receptor Rfc="BBB010101BBB" UsoCFDI="G03"/></cfdi:Comprobante>`;

// ─── parseComplementoNomina ──────────────────────────────────────────────────

describe("parseComplementoNomina", () => {
  it("extrae todos los campos del receptor del complemento", () => {
    const r = parseComplementoNomina(NOMINA_ORDINARIA);
    expect(r).not.toBeNull();
    expect(r!.rfc).toBe("MARP850101AAA");
    expect(r!.nombre).toBe("MARIA PEREZ RAMIREZ");
    expect(r!.curp).toBe("MARP850101MDFRRR05");
    expect(r!.nss).toBe("12345678901");
    expect(r!.fechaInicioRelLaboral).toBe("2022-03-01");
    expect(r!.tipoContrato).toBe("01");
    expect(r!.tipoRegimen).toBe("02");
    expect(r!.puesto).toBe("Analista");
    expect(r!.departamento).toBe("Operaciones");
    expect(r!.riesgoPuesto).toBe("2");
    expect(r!.periodicidadPago).toBe("04");
    expect(r!.sbc).toBeCloseTo(520.55, 2);
    expect(r!.sdi).toBeCloseTo(545, 2);
    expect(r!.tipoNomina).toBe("O");
    expect(r!.fechaPago).toBe("2026-06-15");
    expect(r!.totalPercepciones).toBeCloseTo(7500, 2);
    expect(r!.esFiniquito).toBe(false);
  });

  it("detecta finiquito por SeparacionIndemnizacion y TipoPercepcion 025", () => {
    const r = parseComplementoNomina(NOMINA_FINIQUITO);
    expect(r).not.toBeNull();
    expect(r!.rfc).toBe("GOLC900202BBB");
    expect(r!.tipoNomina).toBe("E");
    expect(r!.esFiniquito).toBe(true);
  });

  it("devuelve null para un CFDI que no es de nómina", () => {
    expect(parseComplementoNomina(INGRESO)).toBeNull();
  });

  it("devuelve null ante XML vacío o ilegible", () => {
    expect(parseComplementoNomina("")).toBeNull();
    expect(parseComplementoNomina(null)).toBeNull();
    expect(parseComplementoNomina(undefined)).toBeNull();
    expect(parseComplementoNomina("<basura>no es cfdi</basura>")).toBeNull();
  });

  it("devuelve null si es tipo N pero sin complemento de nómina", () => {
    const sinComplemento = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" TipoDeComprobante="N" Total="0"><cfdi:Emisor Rfc="AAA010101AAA"/><cfdi:Receptor Rfc="BBB010101BBB"/></cfdi:Comprobante>`;
    expect(parseComplementoNomina(sinComplemento)).toBeNull();
  });
});

// ─── clasificarEmpleado ──────────────────────────────────────────────────────

const HOY = new Date("2026-06-30T00:00:00Z");
const dias = (n: number) => new Date(HOY.getTime() - n * 86400000);

function recibo(fechaPago: Date, opts?: Partial<ReciboEvento>): ReciboEvento {
  return { fechaPago, tipoNomina: "O", esFiniquito: false, ...opts };
}

describe("clasificarEmpleado", () => {
  it("ACTIVO: recibo ordinario dentro de la ventana (quincenal)", () => {
    const estado = clasificarEmpleado({
      recibos: [recibo(dias(5)), recibo(dias(20))],
      hoy: HOY,
      cadencia: "04",
    });
    expect(estado).toBe("ACTIVO");
  });

  it("BAJA: el último evento es un finiquito", () => {
    const estado = clasificarEmpleado({
      recibos: [recibo(dias(40)), recibo(dias(10), { tipoNomina: "E", esFiniquito: true })],
      hoy: HOY,
      cadencia: "04",
    });
    expect(estado).toBe("BAJA");
  });

  it("PROBABLE_BAJA: sin recibo reciente y sin finiquito (gap por permiso)", () => {
    const estado = clasificarEmpleado({
      recibos: [recibo(dias(120)), recibo(dias(150))],
      hoy: HOY,
      cadencia: "04",
    });
    expect(estado).toBe("PROBABLE_BAJA");
  });

  it("PROBABLE_BAJA: incapacidad/licencia larga NO se descarta", () => {
    // Último recibo hace 70 días (fuera de ventana quincenal ~35d), sin finiquito.
    const estado = clasificarEmpleado({
      recibos: [recibo(dias(70))],
      hoy: HOY,
      cadencia: "04",
    });
    expect(estado).toBe("PROBABLE_BAJA");
  });

  it("ACTIVO: mensual con recibo a 40 días entra por la ventana de 2 periodos", () => {
    const estado = clasificarEmpleado({
      recibos: [recibo(dias(40))],
      hoy: HOY,
      cadencia: "05", // mensual → ventana ~65 días
    });
    expect(estado).toBe("ACTIVO");
  });

  it("tope duro de 90 días: nada más viejo cuenta como activo aunque la cadencia sea larga", () => {
    const estado = clasificarEmpleado({
      recibos: [recibo(dias(95))],
      hoy: HOY,
      cadencia: "06", // bimestral → ventana se topa en 90 días
    });
    expect(estado).toBe("PROBABLE_BAJA");
  });

  it("recibo EXTRAORDINARIO reciente NO basta para ACTIVO (aguinaldo, bono)", () => {
    const estado = clasificarEmpleado({
      recibos: [recibo(dias(5), { tipoNomina: "E" }), recibo(dias(100))],
      hoy: HOY,
      cadencia: "04",
    });
    expect(estado).toBe("PROBABLE_BAJA");
  });

  it("sin recibos → PROBABLE_BAJA (nunca se descarta)", () => {
    const estado = clasificarEmpleado({ recibos: [], hoy: HOY, cadencia: "04" });
    expect(estado).toBe("PROBABLE_BAJA");
  });

  it("cadencia desconocida usa default quincenal", () => {
    const estado = clasificarEmpleado({
      recibos: [recibo(dias(10))],
      hoy: HOY,
      cadencia: null,
    });
    expect(estado).toBe("ACTIVO");
  });
});
