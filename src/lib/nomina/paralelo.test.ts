import { describe, it, expect } from "vitest";
import {
  compararRecibo,
  parseEntradaParalelo,
  TOLERANCIA_PESOS,
  type EntradaComparacion,
} from "./paralelo";
import { calcularImss } from "./imss";
import { umaDiariaDelEjercicio } from "./constants";

// ─── Entradas base ────────────────────────────────────────────────────────────
// Valores dorados calculados A MANO contra las tablas versionadas (no contra el
// motor), para que el test detecte una regresión del motor:
//
// 2026, quincenal, gravado 7,500 → base mensual 15,200:
//   ISR mensual = 1,339.14 + (15,200 − 14,644.65) × 17.92% = 1,438.6587
//   sin subsidio (>$11,492.66) → retención quincenal = ×15/30.4 = $709.86
//   IMSS obrero (SBC 520.55, 15 días, UMA 117.31): excedente 10.12 + dinero
//   19.52 + GMP 29.28 + IyV 48.80 + CEAV 87.84 = $195.56
//
// 2024, quincenal, gravado 7,500 → base mensual 15,200:
//   ISR mensual = 1,182.88 + (15,200 − 12,935.83) × 17.92% = 1,588.6193
//   → retención quincenal $783.86; IMSS (UMA 108.57) = $197.13
//
// 2024, quincenal, gravado 4,000 → base mensual 8,106.67:
//   ISR mensual = 371.83 + (8,106.67 − 6,332.06) × 10.88% = 564.9072
//   subsidio 2024 = 11.82% × UMA mensual 2024 (3,300.528) = $390.12
//   → retención quincenal = (564.9072 − 390.12) × 15/30.4 = $86.24
//   (con la tabla de subsidio 2013 el proveedor no daba subsidio a ese nivel:
//   habría retenido 564.9072 × 15/30.4 = $278.74)

function entrada2026(overrides: Partial<EntradaComparacion> = {}): EntradaComparacion {
  return {
    fechaPago: "2026-06-15",
    periodicidadPago: "04",
    diasPagados: 15,
    diasPeriodo: 15,
    sbcDiario: 520.55,
    totalGravado: 7500,
    totalExento: 0,
    gravadoPorCodigo: { "001": 7500 },
    tipoNomina: "O",
    esFiniquito: false,
    timbrado: { isr: 709.86, imssObrero: 195.56, subsidioEntregado: 0 },
    ...overrides,
  };
}

function entrada2024(overrides: Partial<EntradaComparacion> = {}): EntradaComparacion {
  return entrada2026({
    fechaPago: "2024-08-15",
    timbrado: { isr: 783.86, imssObrero: 197.13, subsidioEntregado: 0 },
    ...overrides,
  });
}

describe("compararRecibo — coincidencias", () => {
  it("coincide exacto: 2026 quincenal con lo que timbraría un motor correcto", () => {
    const r = compararRecibo(entrada2026());
    expect(r.comparable).toBe(true);
    expect(r.veredicto).toBe("coincide");
    expect(r.ejercicio).toBe(2026);
    expect(r.isr!.nuestro).toBeCloseTo(709.86, 2);
    expect(r.isr!.delta).toBeCloseTo(0, 2);
    expect(r.imssObrero!.nuestro).toBeCloseTo(195.56, 2);
    expect(r.imssObrero!.delta).toBeCloseTo(0, 2);
    expect(r.subsidio!.delta).toBeCloseTo(0, 2);
  });

  it("tolerancia: ±$0.50 en un concepto sigue siendo coincidencia", () => {
    const r = compararRecibo(
      entrada2026({ timbrado: { isr: 709.36, imssObrero: 195.56, subsidioEntregado: 0 } })
    );
    expect(r.veredicto).toBe("coincide");
    expect(r.isr!.delta).toBeCloseTo(0.5, 2);
    expect(Math.abs(r.isr!.delta)).toBeLessThanOrEqual(TOLERANCIA_PESOS);
  });

  it("difiere: una diferencia real de $50 en ISR rebasa la tolerancia", () => {
    const r = compararRecibo(
      entrada2026({ timbrado: { isr: 659.86, imssObrero: 195.56, subsidioEntregado: 0 } })
    );
    expect(r.veredicto).toBe("difiere");
    expect(r.isr!.delta).toBeCloseTo(50, 2);
  });
});

describe("compararRecibo — enrutamiento por ejercicio (tablas vigentes a la fecha de pago)", () => {
  it("mismos insumos, 2024 vs 2026: cada año coincide contra SU tabla", () => {
    const r24 = compararRecibo(entrada2024());
    const r26 = compararRecibo(entrada2026());
    expect(r24.veredicto).toBe("coincide");
    expect(r26.veredicto).toBe("coincide");
    expect(r24.isr!.nuestro).toBeCloseTo(783.86, 2);
    expect(r26.isr!.nuestro).toBeCloseTo(709.86, 2);
    // Las tablas de cada ejercicio producen ISR distinto — no hay roll-forward silencioso.
    expect(r24.isr!.nuestro).not.toBeCloseTo(r26.isr!.nuestro, 0);
    expect(r24.imssObrero!.nuestro).toBeCloseTo(197.13, 2);
    expect(r26.imssObrero!.nuestro).toBeCloseTo(195.56, 2);
  });

  it("recibo 2024 timbrado con la tabla 2026 → difiere (delta +$74.00 en ISR)", () => {
    const r = compararRecibo(
      entrada2024({ timbrado: { isr: 709.86, imssObrero: 197.13, subsidioEntregado: 0 } })
    );
    expect(r.veredicto).toBe("difiere");
    expect(r.isr!.delta).toBeCloseTo(74.0, 2);
  });

  it("subsidio 2024 con UMA 2024 ($390.12): gravado 4,000 quincenal → ISR $86.24", () => {
    const r = compararRecibo(
      entrada2024({
        totalGravado: 4000,
        gravadoPorCodigo: { "001": 4000 },
        sbcDiario: 300,
        timbrado: { isr: 86.24, imssObrero: 106.89, subsidioEntregado: 0 },
      })
    );
    expect(r.veredicto).toBe("coincide");
    expect(r.isr!.nuestro).toBeCloseTo(86.24, 2);
  });

  it("proveedor con subsidio viejo (tabla 2013, sin subsidio a ese nivel) → difiere en ISR", () => {
    const r = compararRecibo(
      entrada2024({
        totalGravado: 4000,
        gravadoPorCodigo: { "001": 4000 },
        sbcDiario: 300,
        // El proveedor retuvo sin el subsidio del decreto 2024: $278.74.
        timbrado: { isr: 278.74, imssObrero: 106.89, subsidioEntregado: 0 },
      })
    );
    expect(r.veredicto).toBe("difiere");
    expect(r.isr!.delta).toBeCloseTo(-192.5, 1);
  });

  it("ejercicio sin tablas verificadas (2023) → no comparable, nunca calcula con otro año", () => {
    const r = compararRecibo(entrada2026({ fechaPago: "2023-06-15" }));
    expect(r.veredicto).toBe("no-comparable");
    expect(r.motivoNoComparable).toMatch(/2023/);
  });
});

describe("compararRecibo — régimen de subsidio (transiciones)", () => {
  it("ene-abr 2024 con subsidio en juego (tabla 2013 no modelada) → no comparable", () => {
    const r = compararRecibo(
      entrada2024({
        fechaPago: "2024-03-15",
        totalGravado: 4000,
        gravadoPorCodigo: { "001": 4000 },
        sbcDiario: 300,
      })
    );
    expect(r.veredicto).toBe("no-comparable");
    expect(r.motivoNoComparable).toMatch(/1-may-2024/);
  });

  it("ene-abr 2024 por ENCIMA del tope de subsidio → sí comparable (ningún régimen da subsidio)", () => {
    const r = compararRecibo(entrada2024({ fechaPago: "2024-03-15" }));
    expect(r.comparable).toBe(true);
    expect(r.isr!.nuestro).toBeCloseTo(783.86, 2);
  });

  it("enero 2025 con subsidio en juego (transitorio de enero no modelado) → no comparable", () => {
    const r = compararRecibo(
      entrada2024({
        fechaPago: "2025-01-15",
        totalGravado: 4000,
        gravadoPorCodigo: { "001": 4000 },
        sbcDiario: 300,
      })
    );
    expect(r.veredicto).toBe("no-comparable");
    expect(r.motivoNoComparable).toMatch(/enero/i);
  });

  it("enero 2026 (transitorio modelado vía pct de enero) → comparable", () => {
    const r = compararRecibo(
      entrada2026({
        fechaPago: "2026-01-15",
        totalGravado: 4000,
        gravadoPorCodigo: { "001": 4000 },
        sbcDiario: 300,
        // Base mensual 8,106.67 ≤ salario mínimo mensual 2026 → exento, retención 0.
        // IMSS obrero (SBC 300, sin excedente de 3 UMA): 11.25+16.88+28.13+50.63 = 106.89.
        timbrado: { isr: 0, imssObrero: 106.89, subsidioEntregado: 0 },
      })
    );
    expect(r.comparable).toBe(true);
    expect(r.isr!.nuestro).toBe(0);
  });

  it("subsidio ENTREGADO timbrado tras el decreto (no devolutivo) → difiere en subsidio", () => {
    const r = compararRecibo(
      entrada2026({ timbrado: { isr: 709.86, imssObrero: 195.56, subsidioEntregado: 250 } })
    );
    expect(r.veredicto).toBe("difiere");
    expect(r.subsidio!.delta).toBeCloseTo(-250, 2);
  });
});

describe("compararRecibo — no comparables por insumos o tipo de corrida", () => {
  it("sin SBC → no comparable", () => {
    const r = compararRecibo(entrada2026({ sbcDiario: null }));
    expect(r.veredicto).toBe("no-comparable");
    expect(r.motivoNoComparable).toMatch(/SBC/);
  });

  it("recibo extraordinario (aguinaldo/PTU) → no comparable", () => {
    const r = compararRecibo(entrada2026({ tipoNomina: "E" }));
    expect(r.veredicto).toBe("no-comparable");
    expect(r.motivoNoComparable).toMatch(/ordinarias/);
  });

  it("finiquito → no comparable", () => {
    const r = compararRecibo(entrada2026({ esFiniquito: true }));
    expect(r.veredicto).toBe("no-comparable");
  });

  it("PTU gravada dentro de una ordinaria (tratamiento especial de ISR) → no comparable", () => {
    const r = compararRecibo(
      entrada2026({
        totalGravado: 12500,
        gravadoPorCodigo: { "001": 7500, "003": 5000 },
      })
    );
    expect(r.veredicto).toBe("no-comparable");
    expect(r.motivoNoComparable).toMatch(/PTU/);
  });

  it("prima vacacional EXENTA no bloquea (sólo la gravada tiene tratamiento especial)", () => {
    const r = compararRecibo(
      entrada2026({ totalExento: 800, gravadoPorCodigo: { "001": 7500, "021": 0 } })
    );
    expect(r.comparable).toBe(true);
  });

  it("sin días pagados / sin periodicidad / sin base gravable → no comparable", () => {
    expect(compararRecibo(entrada2026({ diasPagados: null })).veredicto).toBe("no-comparable");
    expect(compararRecibo(entrada2026({ periodicidadPago: null })).veredicto).toBe("no-comparable");
    expect(
      compararRecibo(entrada2026({ totalGravado: 0, gravadoPorCodigo: {} })).veredicto
    ).toBe("no-comparable");
  });
});

describe("compararRecibo — convención de días del IMSS", () => {
  it("quincena de 16 días naturales cotizada con 16 días coincide vía diasPeriodo", () => {
    const uma = umaDiariaDelEjercicio(2026)!;
    const imss16 = calcularImss({
      salarioBaseCotizacion: 520.55,
      diasPagados: 16,
      riesgoPuesto: "1",
      ejercicio: 2026,
      umaDiaria: uma,
    }).obrero.total;
    const r = compararRecibo(
      entrada2026({
        fechaPago: "2026-07-31",
        diasPagados: 15,
        diasPeriodo: 16,
        timbrado: { isr: 709.86, imssObrero: imss16, subsidioEntregado: 0 },
      })
    );
    expect(r.veredicto).toBe("coincide");
    expect(r.imssConvencionDias).toBe("diasPeriodo");
    expect(r.imssObrero!.delta).toBeCloseTo(0, 2);
  });
});

// ─── Parser de insumos desde el CFDI timbrado ─────────────────────────────────

function reciboXml(opts: {
  fechaPago?: string;
  fechaInicial?: string;
  fechaFinal?: string;
  diasPagados?: number;
  tipoNomina?: string;
  sbc?: string;
  percepciones?: Array<{ tipo: string; gravado: number; exento?: number }>;
  deducciones?: Array<{ tipo: string; importe: number }>;
  otrosPagos?: Array<{ tipo: string; importe: number }>;
}): string {
  const {
    fechaPago = "2026-06-15",
    fechaInicial = "2026-06-01",
    fechaFinal = "2026-06-15",
    diasPagados = 15,
    tipoNomina = "O",
    sbc = "520.55",
    percepciones = [{ tipo: "001", gravado: 7500 }],
    deducciones = [
      { tipo: "002", importe: 709.86 },
      { tipo: "001", importe: 195.56 },
    ],
    otrosPagos = [],
  } = opts;

  const totPerc = percepciones.reduce((s, p) => s + p.gravado + (p.exento ?? 0), 0);
  const totGrav = percepciones.reduce((s, p) => s + p.gravado, 0);
  const totExen = percepciones.reduce((s, p) => s + (p.exento ?? 0), 0);
  const totDed = deducciones.reduce((s, d) => s + d.importe, 0);
  const totOtros = otrosPagos.reduce((s, o) => s + o.importe, 0);

  const percXml = percepciones
    .map(
      (p) =>
        `<nomina12:Percepcion TipoPercepcion="${p.tipo}" Clave="${p.tipo}" Concepto="P${p.tipo}" ImporteGravado="${p.gravado}" ImporteExento="${p.exento ?? 0}"/>`
    )
    .join("");
  const dedXml =
    deducciones.length > 0
      ? `<nomina12:Deducciones>${deducciones
          .map(
            (d) =>
              `<nomina12:Deduccion TipoDeduccion="${d.tipo}" Clave="${d.tipo}" Concepto="D${d.tipo}" Importe="${d.importe}"/>`
          )
          .join("")}</nomina12:Deducciones>`
      : "";
  const otrosXml =
    otrosPagos.length > 0
      ? `<nomina12:OtrosPagos>${otrosPagos
          .map(
            (o) =>
              `<nomina12:OtroPago TipoOtroPago="${o.tipo}" Clave="${o.tipo}" Concepto="O${o.tipo}" Importe="${o.importe}"/>`
          )
          .join("")}</nomina12:OtrosPagos>`
      : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:nomina12="http://www.sat.gob.mx/nomina12" Version="4.0" TipoDeComprobante="N" SubTotal="${totPerc + totOtros}" Descuento="${totDed}" Total="${totPerc + totOtros - totDed}" Moneda="MXN">
  <cfdi:Emisor Rfc="EPF2502255C8" Nombre="ENLACE PROYECTOS FE" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="MARP850101AAA" Nombre="MARIA PEREZ RAMIREZ" UsoCFDI="CN01"/>
  <cfdi:Complemento>
    <nomina12:Nomina Version="1.2" TipoNomina="${tipoNomina}" FechaPago="${fechaPago}" FechaInicialPago="${fechaInicial}" FechaFinalPago="${fechaFinal}" NumDiasPagados="${diasPagados}" TotalPercepciones="${totPerc}" TotalDeducciones="${totDed}"${totOtros > 0 ? ` TotalOtrosPagos="${totOtros}"` : ""}>
      <nomina12:Receptor Curp="MARP850101MDFRRR05" NumSeguridadSocial="12345678901" FechaInicioRelLaboral="2022-03-01" TipoContrato="01" TipoRegimen="02" NumEmpleado="7" Departamento="Operaciones" Puesto="Analista" RiesgoPuesto="2" PeriodicidadPago="04" SalarioBaseCotApor="${sbc}" SalarioDiarioIntegrado="545.00"/>
      <nomina12:Percepciones TotalGravado="${totGrav}" TotalExento="${totExen}">${percXml}</nomina12:Percepciones>
      ${dedXml}
      ${otrosXml}
    </nomina12:Nomina>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}

describe("parseEntradaParalelo — insumos desde el CFDI timbrado", () => {
  it("extrae la partición gravado/exento, SBC, días y lo timbrado", () => {
    const xml = reciboXml({
      percepciones: [
        { tipo: "001", gravado: 7000, exento: 0 },
        { tipo: "029", gravado: 0, exento: 500 },
      ],
      deducciones: [
        { tipo: "002", importe: 650.5 },
        { tipo: "001", importe: 180.25 },
        { tipo: "004", importe: 100 },
      ],
      otrosPagos: [{ tipo: "002", importe: 150 }],
    });
    const e = parseEntradaParalelo(xml)!;
    expect(e).not.toBeNull();
    expect(e.fechaPago).toBe("2026-06-15");
    expect(e.periodicidadPago).toBe("04");
    expect(e.diasPagados).toBe(15);
    expect(e.diasPeriodo).toBe(15);
    expect(e.sbcDiario).toBeCloseTo(520.55, 2);
    expect(e.totalGravado).toBeCloseTo(7000, 2);
    expect(e.totalExento).toBeCloseTo(500, 2);
    expect(e.gravadoPorCodigo!["001"]).toBeCloseTo(7000, 2);
    expect(e.timbrado.isr).toBeCloseTo(650.5, 2);
    expect(e.timbrado.imssObrero).toBeCloseTo(180.25, 2);
    expect(e.timbrado.subsidioEntregado).toBeCloseTo(150, 2);
    expect(e.tipoNomina).toBe("O");
    expect(e.esFiniquito).toBe(false);
  });

  it("quincena de 16 días: diasPeriodo se deriva de las fechas del periodo", () => {
    const e = parseEntradaParalelo(
      reciboXml({ fechaInicial: "2026-07-16", fechaFinal: "2026-07-31", fechaPago: "2026-07-31" })
    )!;
    expect(e.diasPeriodo).toBe(16);
    expect(e.diasPagados).toBe(15);
  });

  it("XML basura → null (no lanza)", () => {
    expect(parseEntradaParalelo("<xml>basura</xml>")).toBeNull();
    expect(parseEntradaParalelo(null)).toBeNull();
  });

  it("integración: recibo timbrado por un motor correcto → parse + comparar = coincide", () => {
    const e = parseEntradaParalelo(reciboXml({}))!;
    const r = compararRecibo(e);
    expect(r.veredicto).toBe("coincide");
    expect(r.isr!.delta).toBeCloseTo(0, 2);
    expect(r.imssObrero!.delta).toBeCloseTo(0, 2);
  });
});
