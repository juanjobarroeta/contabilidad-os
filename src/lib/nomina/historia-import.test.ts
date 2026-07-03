import { describe, it, expect } from "vitest";
import {
  parseReciboNominaHistorico,
  derivarTipoCorrida,
  construirCorridasHistoricas,
  detectarPeriodicidad,
  siguientePeriodo,
  type ReciboConUuid,
} from "./historia-import";

// ─── Fixtures de CFDI de nómina 1.2 ──────────────────────────────────────────
// Mismo formato que los del roster (roster-import.test.ts), con el desglose
// completo de percepciones/deducciones/otros pagos que usa el histórico.

function reciboXml(opts: {
  rfc?: string;
  nombre?: string;
  tipoNomina?: string;
  fechaPago?: string;
  fechaInicial?: string | null;
  fechaFinal?: string | null;
  diasPagados?: number;
  percepciones?: Array<{ tipo: string; gravado: number; exento?: number }>;
  deducciones?: Array<{ tipo: string; importe: number }>;
  otrosPagos?: Array<{ tipo: string; importe: number }>;
  emisorRfc?: string;
  separacion?: boolean;
}): string {
  const {
    rfc = "MARP850101AAA",
    nombre = "MARIA PEREZ RAMIREZ",
    tipoNomina = "O",
    fechaPago = "2026-06-15",
    fechaInicial = "2026-06-01",
    fechaFinal = "2026-06-15",
    diasPagados = 15,
    percepciones = [{ tipo: "001", gravado: 7500 }],
    deducciones = [],
    otrosPagos = [],
    emisorRfc = "EPF2502255C8",
    separacion = false,
  } = opts;

  const totPerc = percepciones.reduce((s, p) => s + p.gravado + (p.exento ?? 0), 0);
  const totDed = deducciones.reduce((s, d) => s + d.importe, 0);
  const totOtros = otrosPagos.reduce((s, o) => s + o.importe, 0);

  const percXml = percepciones
    .map((p) =>
      separacion && p.tipo === "025"
        ? `<nomina12:Percepcion TipoPercepcion="${p.tipo}" Clave="${p.tipo}" Concepto="Sep" ImporteGravado="${p.gravado}" ImporteExento="${p.exento ?? 0}"><nomina12:SeparacionIndemnizacion TotalPagado="${p.gravado + (p.exento ?? 0)}" NumAniosServicio="3" UltimoSueldoMensOrd="10000" IngresoAcumulable="${p.gravado}" IngresoNoAcumulable="${p.exento ?? 0}"/></nomina12:Percepcion>`
        : `<nomina12:Percepcion TipoPercepcion="${p.tipo}" Clave="${p.tipo}" Concepto="P${p.tipo}" ImporteGravado="${p.gravado}" ImporteExento="${p.exento ?? 0}"/>`
    )
    .join("\n        ");
  const dedXml =
    deducciones.length > 0
      ? `<nomina12:Deducciones TotalOtrasDeducciones="0" TotalImpuestosRetenidos="0">
        ${deducciones.map((d) => `<nomina12:Deduccion TipoDeduccion="${d.tipo}" Clave="${d.tipo}" Concepto="D${d.tipo}" Importe="${d.importe}"/>`).join("\n        ")}
      </nomina12:Deducciones>`
      : "";
  const otrosXml =
    otrosPagos.length > 0
      ? `<nomina12:OtrosPagos>
        ${otrosPagos.map((o) => `<nomina12:OtroPago TipoOtroPago="${o.tipo}" Clave="${o.tipo}" Concepto="O${o.tipo}" Importe="${o.importe}"/>`).join("\n        ")}
      </nomina12:OtrosPagos>`
      : "";

  const periodoAttrs =
    fechaInicial && fechaFinal
      ? ` FechaInicialPago="${fechaInicial}" FechaFinalPago="${fechaFinal}" NumDiasPagados="${diasPagados}"`
      : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:nomina12="http://www.sat.gob.mx/nomina12" Version="4.0" Fecha="${fechaPago}T12:00:00" TipoDeComprobante="N" SubTotal="${totPerc + totOtros}" Descuento="${totDed}" Total="${totPerc + totOtros - totDed}" Moneda="MXN">
  <cfdi:Emisor Rfc="${emisorRfc}" Nombre="ENLACE PROYECTOS FE" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${rfc}" Nombre="${nombre}" UsoCFDI="CN01"/>
  <cfdi:Complemento>
    <nomina12:Nomina Version="1.2" TipoNomina="${tipoNomina}" FechaPago="${fechaPago}"${periodoAttrs} TotalPercepciones="${totPerc}" TotalDeducciones="${totDed}"${totOtros > 0 ? ` TotalOtrosPagos="${totOtros}"` : ""}>
      <nomina12:Receptor Curp="MARP850101MDFRRR05" NumSeguridadSocial="12345678901" FechaInicioRelLaboral="2022-03-01" TipoContrato="01" TipoRegimen="02" NumEmpleado="7" Departamento="Operaciones" Puesto="Analista" RiesgoPuesto="2" PeriodicidadPago="04" SalarioBaseCotApor="520.55" SalarioDiarioIntegrado="545.00"/>
      <nomina12:Percepciones TotalGravado="${totPerc}" TotalExento="0">
        ${percXml}
      </nomina12:Percepciones>
      ${dedXml}
      ${otrosXml}
    </nomina12:Nomina>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="11111111-1111-1111-1111-111111111111"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}

const recibo = (uuid: string, opts: Parameters<typeof reciboXml>[0] = {}): ReciboConUuid => ({
  uuid,
  recibo: parseReciboNominaHistorico(reciboXml(opts))!,
});

// ─── parseReciboNominaHistorico ──────────────────────────────────────────────

describe("parseReciboNominaHistorico", () => {
  it("extrae periodo, días pagados y el desglose mapeado a PayrollItem", () => {
    const r = parseReciboNominaHistorico(
      reciboXml({
        percepciones: [
          { tipo: "001", gravado: 7000 },
          { tipo: "019", gravado: 300 }, // horas extra
          { tipo: "029", gravado: 0, exento: 200 }, // vales
          { tipo: "038", gravado: 100 }, // otra percepción
        ],
        deducciones: [
          { tipo: "002", importe: 850 }, // ISR
          { tipo: "001", importe: 320.5 }, // IMSS obrero
          { tipo: "010", importe: 150 }, // crédito vivienda (INFONAVIT)
          { tipo: "004", importe: 50 }, // otra
        ],
        otrosPagos: [
          { tipo: "002", importe: 120 }, // subsidio al empleo
          { tipo: "003", importe: 80 },
        ],
      })
    );
    expect(r).not.toBeNull();
    expect(r!.rfcEmisor).toBe("EPF2502255C8");
    expect(r!.fechaInicialPago).toBe("2026-06-01");
    expect(r!.fechaFinalPago).toBe("2026-06-15");
    expect(r!.numDiasPagados).toBe(15);
    expect(r!.complemento.rfc).toBe("MARP850101AAA");
    expect(r!.complemento.fechaPago).toBe("2026-06-15");

    const d = r!.desglose;
    expect(d.sueldoBase).toBeCloseTo(7000, 2);
    expect(d.horasExtra).toBeCloseTo(300, 2);
    expect(d.vales).toBeCloseTo(200, 2); // gravado + exento
    expect(d.otrasPercepciones).toBeCloseTo(100, 2);
    expect(d.isrRetenido).toBeCloseTo(850, 2);
    expect(d.imssObrero).toBeCloseTo(320.5, 2);
    expect(d.infonavit).toBeCloseTo(150, 2);
    expect(d.otrasDeducc).toBeCloseTo(50, 2);
    expect(d.subsidioEmpleo).toBeCloseTo(120, 2);
    expect(d.otrosPagos).toBeCloseTo(80, 2);
    expect(d.totalPercepciones).toBeCloseTo(7600, 2);
    expect(d.totalDeducciones).toBeCloseTo(1370.5, 2);
    expect(d.totalOtrosPagos).toBeCloseTo(200, 2);
    // Neto = percepciones + otros pagos − deducciones
    expect(d.netoAPagar).toBeCloseTo(7600 + 200 - 1370.5, 2);
  });

  it("recibo sin FechaInicial/FinalPago (finiquito) devuelve periodo null", () => {
    const r = parseReciboNominaHistorico(
      reciboXml({
        tipoNomina: "E",
        fechaInicial: null,
        fechaFinal: null,
        percepciones: [{ tipo: "025", gravado: 20000, exento: 10000 }],
        separacion: true,
      })
    );
    expect(r).not.toBeNull();
    expect(r!.fechaInicialPago).toBeNull();
    expect(r!.fechaFinalPago).toBeNull();
    expect(r!.complemento.esFiniquito).toBe(true);
    expect(r!.desglose.otrasPercepciones).toBeCloseTo(30000, 2); // 025 no tiene columna propia
  });

  it("devuelve null para CFDIs que no son de nómina o XML basura", () => {
    expect(parseReciboNominaHistorico(null)).toBeNull();
    expect(parseReciboNominaHistorico("")).toBeNull();
    expect(parseReciboNominaHistorico("<basura/>")).toBeNull();
    const ingreso = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I" Total="116"><cfdi:Emisor Rfc="AAA010101AAA"/><cfdi:Receptor Rfc="BBB010101BBB"/></cfdi:Comprobante>`;
    expect(parseReciboNominaHistorico(ingreso)).toBeNull();
  });
});

// ─── derivarTipoCorrida ──────────────────────────────────────────────────────

describe("derivarTipoCorrida", () => {
  it("ordinaria, aguinaldo, PTU, extraordinaria y finiquito", () => {
    expect(derivarTipoCorrida(recibo("A").recibo)).toBe("ORDINARIA");
    expect(
      derivarTipoCorrida(
        recibo("B", { tipoNomina: "E", percepciones: [{ tipo: "002", gravado: 5000 }] }).recibo
      )
    ).toBe("AGUINALDO");
    expect(
      derivarTipoCorrida(
        recibo("C", { tipoNomina: "E", percepciones: [{ tipo: "003", gravado: 4000 }] }).recibo
      )
    ).toBe("PTU");
    expect(
      derivarTipoCorrida(
        recibo("D", { tipoNomina: "E", percepciones: [{ tipo: "038", gravado: 1000 }] }).recibo
      )
    ).toBe("EXTRAORDINARIA");
    expect(
      derivarTipoCorrida(
        recibo("E", {
          tipoNomina: "E",
          fechaInicial: null,
          fechaFinal: null,
          percepciones: [{ tipo: "025", gravado: 20000 }],
          separacion: true,
        }).recibo
      )
    ).toBe("FINIQUITO");
  });
});

// ─── construirCorridasHistoricas (agrupación + REGLA DE DEDUP) ───────────────

describe("construirCorridasHistoricas", () => {
  const UUID_A = "AAAAAAAA-0000-0000-0000-000000000001";
  const UUID_B = "AAAAAAAA-0000-0000-0000-000000000002";
  const UUID_C = "AAAAAAAA-0000-0000-0000-000000000003";

  it("agrupa recibos del mismo periodo en UNA corrida con totales sumados", () => {
    const corridas = construirCorridasHistoricas(
      [
        recibo(UUID_A, { rfc: "MARP850101AAA", deducciones: [{ tipo: "002", importe: 900 }] }),
        recibo(UUID_B, { rfc: "GOLC900202BBB", deducciones: [{ tipo: "002", importe: 500 }] }),
      ],
      new Set()
    );
    expect(corridas).toHaveLength(1);
    expect(corridas[0].periodo).toBe("2026-06-01/2026-06-15");
    expect(corridas[0].tipo).toBe("ORDINARIA");
    expect(corridas[0].fechaPago).toBe("2026-06-15");
    expect(corridas[0].recibos).toHaveLength(2);
    expect(corridas[0].totalPercepciones).toBeCloseTo(15000, 2);
    expect(corridas[0].totalDeducciones).toBeCloseTo(1400, 2);
    expect(corridas[0].totalNeto).toBeCloseTo(13600, 2);
  });

  it("periodos distintos crean corridas distintas, ordenadas cronológicamente", () => {
    const corridas = construirCorridasHistoricas(
      [
        recibo(UUID_B, { fechaPago: "2026-06-30", fechaInicial: "2026-06-16", fechaFinal: "2026-06-30" }),
        recibo(UUID_A, { fechaPago: "2026-06-15", fechaInicial: "2026-06-01", fechaFinal: "2026-06-15" }),
      ],
      new Set()
    );
    expect(corridas).toHaveLength(2);
    expect(corridas[0].periodo).toBe("2026-06-01/2026-06-15");
    expect(corridas[1].periodo).toBe("2026-06-16/2026-06-30");
  });

  it("REGLA DE DEDUP: un uuid ya vinculado a un PayrollItem se omite", () => {
    const corridas = construirCorridasHistoricas(
      [recibo(UUID_A, { rfc: "MARP850101AAA" }), recibo(UUID_B, { rfc: "GOLC900202BBB" })],
      new Set([UUID_A]) // A ya fue timbrado desde la app o importado antes
    );
    expect(corridas).toHaveLength(1);
    expect(corridas[0].recibos).toHaveLength(1);
    expect(corridas[0].recibos[0].uuid).toBe(UUID_B);
  });

  it("dedup insensible a mayúsculas/minúsculas del folio fiscal", () => {
    const corridas = construirCorridasHistoricas(
      [recibo(UUID_A.toLowerCase() as string)],
      new Set([UUID_A])
    );
    expect(corridas).toHaveLength(0);
  });

  it("si TODOS los uuids ya están vinculados no crea nada (re-ejecución idempotente)", () => {
    const corridas = construirCorridasHistoricas(
      [recibo(UUID_A), recibo(UUID_B)],
      new Set([UUID_A, UUID_B])
    );
    expect(corridas).toHaveLength(0);
  });

  it("un finiquito en las mismas fechas queda en su propia corrida (tipo distinto)", () => {
    const corridas = construirCorridasHistoricas(
      [
        recibo(UUID_A, { rfc: "MARP850101AAA" }),
        recibo(UUID_C, {
          rfc: "GOLC900202BBB",
          tipoNomina: "E",
          fechaInicial: "2026-06-01",
          fechaFinal: "2026-06-15",
          percepciones: [{ tipo: "025", gravado: 20000 }],
          separacion: true,
        }),
      ],
      new Set()
    );
    expect(corridas).toHaveLength(2);
    expect(corridas.map((c) => c.tipo).sort()).toEqual(["FINIQUITO", "ORDINARIA"]);
  });

  it("recibos sin periodo usan la fecha de pago como periodo de un día", () => {
    const corridas = construirCorridasHistoricas(
      [
        recibo(UUID_A, {
          tipoNomina: "E",
          fechaPago: "2026-05-20",
          fechaInicial: null,
          fechaFinal: null,
          percepciones: [{ tipo: "025", gravado: 30000 }],
          separacion: true,
        }),
      ],
      new Set()
    );
    expect(corridas).toHaveLength(1);
    expect(corridas[0].periodo).toBe("2026-05-20/2026-05-20");
  });

  it("la fecha de pago de la corrida es la más frecuente del grupo", () => {
    const corridas = construirCorridasHistoricas(
      [
        recibo(UUID_A, { rfc: "AAAA850101AAA", fechaPago: "2026-06-15" }),
        recibo(UUID_B, { rfc: "BBBB850101BBB", fechaPago: "2026-06-16" }),
        recibo(UUID_C, { rfc: "CCCC850101CCC", fechaPago: "2026-06-16" }),
      ],
      new Set()
    );
    // Mismo periodo (el builder usa 06-01/06-15 por default) → una corrida.
    expect(corridas).toHaveLength(1);
    expect(corridas[0].fechaPago).toBe("2026-06-16");
  });
});

// ─── detectarPeriodicidad ────────────────────────────────────────────────────

const d = (s: string) => new Date(s);

describe("detectarPeriodicidad", () => {
  it("semanal (7 días)", () => {
    expect(detectarPeriodicidad(d("2026-06-01"), d("2026-06-07"))).toBe("SEMANAL");
  });
  it("quincenal (1-15 y 16-fin de mes)", () => {
    expect(detectarPeriodicidad(d("2026-06-01"), d("2026-06-15"))).toBe("QUINCENAL");
    expect(detectarPeriodicidad(d("2026-06-16"), d("2026-06-30"))).toBe("QUINCENAL");
    expect(detectarPeriodicidad(d("2026-01-16"), d("2026-01-31"))).toBe("QUINCENAL"); // 16 días
    expect(detectarPeriodicidad(d("2026-02-16"), d("2026-02-28"))).toBe("QUINCENAL"); // 13 días
  });
  it("catorcenal se trata como quincenal", () => {
    expect(detectarPeriodicidad(d("2026-06-01"), d("2026-06-14"))).toBe("QUINCENAL");
  });
  it("mensual (mes calendario)", () => {
    expect(detectarPeriodicidad(d("2026-06-01"), d("2026-06-30"))).toBe("MENSUAL");
    expect(detectarPeriodicidad(d("2026-02-01"), d("2026-02-28"))).toBe("MENSUAL");
  });
});

// ─── siguientePeriodo ────────────────────────────────────────────────────────

describe("siguientePeriodo", () => {
  it("primera quincena → segunda quincena del mismo mes", () => {
    const s = siguientePeriodo({
      periodoInicio: d("2026-06-01"),
      periodoFin: d("2026-06-15"),
      fechaPago: d("2026-06-15"),
    });
    expect(s.periodicidad).toBe("QUINCENAL");
    expect(s.periodoInicio).toBe("2026-06-16");
    expect(s.periodoFin).toBe("2026-06-30");
    expect(s.fechaPago).toBe("2026-06-30");
    expect(s.diasPagados).toBe(15);
  });

  it("segunda quincena → primera quincena del mes siguiente", () => {
    const s = siguientePeriodo({
      periodoInicio: d("2026-06-16"),
      periodoFin: d("2026-06-30"),
      fechaPago: d("2026-06-30"),
    });
    expect(s.periodoInicio).toBe("2026-07-01");
    expect(s.periodoFin).toBe("2026-07-15");
    expect(s.fechaPago).toBe("2026-07-15");
  });

  it("maneja febrero (fin de mes corto) y meses de 31 días", () => {
    const enero = siguientePeriodo({
      periodoInicio: d("2026-01-16"),
      periodoFin: d("2026-01-31"),
      fechaPago: d("2026-01-31"),
    });
    expect(enero.periodoInicio).toBe("2026-02-01");
    expect(enero.periodoFin).toBe("2026-02-15");

    const feb = siguientePeriodo({
      periodoInicio: d("2026-02-16"),
      periodoFin: d("2026-02-28"),
      fechaPago: d("2026-02-28"),
    });
    expect(feb.periodoInicio).toBe("2026-03-01");
    expect(feb.periodoFin).toBe("2026-03-15");

    const julio = siguientePeriodo({
      periodoInicio: d("2026-07-01"),
      periodoFin: d("2026-07-15"),
      fechaPago: d("2026-07-15"),
    });
    expect(julio.periodoInicio).toBe("2026-07-16");
    expect(julio.periodoFin).toBe("2026-07-31");
  });

  it("semanal avanza 7 días y conserva el desfase de la fecha de pago", () => {
    const s = siguientePeriodo({
      periodoInicio: d("2026-06-01"),
      periodoFin: d("2026-06-07"),
      fechaPago: d("2026-06-08"), // se paga un día después del corte
    });
    expect(s.periodicidad).toBe("SEMANAL");
    expect(s.periodoInicio).toBe("2026-06-08");
    expect(s.periodoFin).toBe("2026-06-14");
    expect(s.fechaPago).toBe("2026-06-15");
    expect(s.diasPagados).toBe(7);
  });

  it("mensual avanza al mes calendario siguiente", () => {
    const s = siguientePeriodo({
      periodoInicio: d("2026-06-01"),
      periodoFin: d("2026-06-30"),
      fechaPago: d("2026-06-30"),
    });
    expect(s.periodicidad).toBe("MENSUAL");
    expect(s.periodoInicio).toBe("2026-07-01");
    expect(s.periodoFin).toBe("2026-07-31");
    expect(s.fechaPago).toBe("2026-07-31");
    expect(s.diasPagados).toBe(30);
  });

  it("la fecha de pago nunca queda antes del inicio del nuevo periodo", () => {
    // Pago muy adelantado al corte (10 días antes del fin del periodo).
    const s = siguientePeriodo({
      periodoInicio: d("2026-06-01"),
      periodoFin: d("2026-06-15"),
      fechaPago: d("2026-06-05"),
    });
    expect(s.fechaPago >= s.periodoInicio).toBe(true);
  });
});
