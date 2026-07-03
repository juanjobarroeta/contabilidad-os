import { describe, it, expect } from "vitest";
import {
  clasificarBasesIvaEgreso,
  operacionesEgresoFlujo,
  type EgresoDelMes,
  type PpdParentEgreso,
} from "./iva-flujo";

// ─────────────────────────────────────────────────────────────────────────────
// IVA en flujo de efectivo para egresos (Art. 1-B LIVA) — la base de la DIOT
// (Art. 32 fracc. VIII LIVA) y del IVA acreditable del motor mensual.
// ─────────────────────────────────────────────────────────────────────────────

type Tax = EgresoDelMes["taxes"][number];

const iva16 = (base: number): Tax => ({
  tipo: "IVA",
  factor: "TASA",
  tasa: 0.16,
  base,
  importe: Math.round(base * 0.16 * 100) / 100,
  retencion: false,
});
const iva0 = (base: number): Tax => ({
  tipo: "IVA",
  factor: "TASA",
  tasa: 0,
  base,
  importe: 0,
  retencion: false,
});
const ivaExento = (base: number): Tax => ({
  tipo: "IVA",
  factor: "EXENTO",
  tasa: 0,
  base,
  importe: 0,
  retencion: false,
});
const ivaRet = (importe: number): Tax => ({
  tipo: "IVA",
  factor: "TASA",
  tasa: 0.106667,
  base: null,
  importe,
  retencion: true,
});

function egresoPue(over: Partial<EgresoDelMes> = {}): EgresoDelMes {
  return {
    metodoPago: "PUE",
    subtotal: 1000,
    total: 1160,
    totalImpuestos: 160,
    taxes: [iva16(1000)],
    rfc: "AAA010101AAA",
    razonSocial: "Proveedor Uno",
    ...over,
  };
}

function egresoPpd(over: Partial<PpdParentEgreso> = {}): PpdParentEgreso {
  return {
    uuid: "UUID-PPD-1",
    metodoPago: "PPD",
    subtotal: 1000,
    total: 1160,
    totalImpuestos: 160,
    taxes: [iva16(1000)],
    rfc: "BBB020202BBB",
    razonSocial: "Proveedor Dos",
    ...over,
  };
}

describe("operacionesEgresoFlujo — flujo de efectivo (Art. 1-B LIVA)", () => {
  it("(1) egreso PUE emitido en el mes → incluido ese mes con sus bases e IVA", () => {
    const ops = operacionesEgresoFlujo({
      egresosDelMes: [egresoPue()],
      repLinksDelMes: [],
      ppdParents: [],
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      rfc: "AAA010101AAA",
      origen: "PUE",
      totalPagado: 1160,
      base16Pagada: 1000,
      base0Pagada: 0,
      exentosPagados: 0,
      ivaAcreditable: 160,
      ivaNoAcreditable: 0,
      ivaRetenido: 0,
    });
  });

  it("(2) egreso PPD emitido en M, REP pagado en M+1 → excluido en M, incluido en M+1 con el IVA del REP", () => {
    const ppd = egresoPpd();

    // Mes M: la factura PPD está emitida pero SIN pago — no debe aparecer.
    const mesM = operacionesEgresoFlujo({
      egresosDelMes: [ppd], // emitida este mes
      repLinksDelMes: [], // ningún pago con FechaPago en M
      ppdParents: [],
    });
    expect(mesM).toHaveLength(0);

    // Mes M+1: el REP (complemento 2.0, IVA firme) dice que se pagó completa.
    const mesM1 = operacionesEgresoFlujo({
      egresosDelMes: [], // no se emitió nada en M+1
      repLinksDelMes: [
        { parentUuid: "UUID-PPD-1", impPagado: 1160, ivaTrasladado: 160, ivaDerivado: false },
      ],
      ppdParents: [ppd],
    });
    expect(mesM1).toHaveLength(1);
    expect(mesM1[0]).toMatchObject({
      rfc: "BBB020202BBB",
      origen: "REP",
      totalPagado: 1160,
      base16Pagada: 1000,
      ivaAcreditable: 160, // valor FIRME del REP 2.0, no prorrateo
      ivaRetenido: 0,
    });
  });

  it("(3) PPD sin REP → nunca se incluye", () => {
    const ops = operacionesEgresoFlujo({
      egresosDelMes: [egresoPpd()],
      repLinksDelMes: [],
      ppdParents: [],
    });
    expect(ops).toHaveLength(0);
  });

  it("(3b) pago de REP cuyo padre no es PPD o es desconocido → ignorado (mismo criterio que el motor)", () => {
    const ops = operacionesEgresoFlujo({
      egresosDelMes: [],
      repLinksDelMes: [
        { parentUuid: "UUID-DESCONOCIDO", impPagado: 500, ivaTrasladado: 68.97, ivaDerivado: false },
        { parentUuid: "UUID-PUE", impPagado: 500, ivaTrasladado: 68.97, ivaDerivado: false },
      ],
      ppdParents: [egresoPpd({ uuid: "UUID-PUE", metodoPago: "PUE" })],
    });
    expect(ops).toHaveLength(0);
  });

  it("(4) pago parcial de REP → sólo la porción pagada (bases y retención prorrateadas)", () => {
    // Factura PPD de 1160 (base 1000 + IVA 160) con retención de IVA de 106.67;
    // REP legacy sin desglose (ivaDerivado) que paga la mitad: 580.
    const ppd = egresoPpd({ taxes: [iva16(1000), ivaRet(106.67)] });
    const ops = operacionesEgresoFlujo({
      egresosDelMes: [],
      repLinksDelMes: [
        { parentUuid: "UUID-PPD-1", impPagado: 580, ivaTrasladado: null, ivaDerivado: true },
      ],
      ppdParents: [ppd],
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].totalPagado).toBe(580);
    expect(ops[0].base16Pagada).toBe(500); // 1000 × (580/1160)
    expect(ops[0].ivaAcreditable).toBe(80); // 160 prorrateado por la fracción pagada
    expect(ops[0].ivaRetenido).toBeCloseTo(53.34, 2); // 106.67 × 0.5
  });

  it("(4b) dos pagos parciales del mismo PPD en el mes → dos operaciones que suman la factura", () => {
    const ppd = egresoPpd();
    const ops = operacionesEgresoFlujo({
      egresosDelMes: [],
      repLinksDelMes: [
        { parentUuid: "UUID-PPD-1", impPagado: 580, ivaTrasladado: 80, ivaDerivado: false },
        { parentUuid: "UUID-PPD-1", impPagado: 580, ivaTrasladado: 80, ivaDerivado: false },
      ],
      ppdParents: [ppd],
    });
    expect(ops).toHaveLength(2);
    expect(ops.reduce((s, o) => s + o.ivaAcreditable, 0)).toBe(160);
    expect(ops.reduce((s, o) => s + o.base16Pagada, 0)).toBe(1000);
  });

  it("IVA marcado no acreditable (bandera manual / proveedor 69-B) → va al bucket ivaNoAcreditable", () => {
    const ops = operacionesEgresoFlujo({
      egresosDelMes: [egresoPue({ ivaNoAcreditable: true })],
      repLinksDelMes: [],
      ppdParents: [],
    });
    expect(ops[0].ivaAcreditable).toBe(0);
    expect(ops[0].ivaNoAcreditable).toBe(160);
    // Las bases pagadas se siguen reportando (la operación existió).
    expect(ops[0].base16Pagada).toBe(1000);
  });
});

describe("clasificarBasesIvaEgreso — (5) tasa 0% vs exento", () => {
  it("traslado con TipoFactor=Tasa y TasaOCuota 0 → acto GRAVADO a tasa 0%", () => {
    const r = clasificarBasesIvaEgreso(egresoPue({ subtotal: 1000, total: 1000, totalImpuestos: 0, taxes: [iva0(1000)] }));
    expect(r.base0).toBe(1000);
    expect(r.exentos).toBe(0);
    expect(r.base16).toBe(0);
    expect(r.iva).toBe(0);
  });

  it("traslado con TipoFactor=Exento → acto EXENTO (no tasa 0%)", () => {
    const r = clasificarBasesIvaEgreso(egresoPue({ subtotal: 1000, total: 1000, totalImpuestos: 0, taxes: [ivaExento(1000)] }));
    expect(r.exentos).toBe(1000);
    expect(r.base0).toBe(0);
    expect(r.base16).toBe(0);
  });

  it("sin traslado de IVA (sin filas y sin totalImpuestos) → EXENTO (conservador)", () => {
    const r = clasificarBasesIvaEgreso(egresoPue({ subtotal: 1000, total: 1000, totalImpuestos: 0, taxes: [] }));
    expect(r.exentos).toBe(1000);
    expect(r.base0).toBe(0);
    expect(r.base16).toBe(0);
    expect(r.iva).toBe(0);
  });

  it("factura mixta 16% + 0% + exento → cada base a su columna", () => {
    const r = clasificarBasesIvaEgreso(
      egresoPue({
        subtotal: 3000,
        total: 3160,
        totalImpuestos: 160,
        taxes: [iva16(1000), iva0(1000), ivaExento(1000)],
      })
    );
    expect(r.base16).toBe(1000);
    expect(r.base0).toBe(1000);
    expect(r.exentos).toBe(1000);
    expect(r.iva).toBe(160);
  });

  it("legacy sin filas pero con totalImpuestos > 0 → gravado 16% (mismo fallback que el motor)", () => {
    const r = clasificarBasesIvaEgreso(egresoPue({ taxes: [] })); // totalImpuestos 160
    expect(r.base16).toBe(1000);
    expect(r.iva).toBe(160); // ivaTrasladadoDe cae a totalImpuestos
    expect(r.exentos).toBe(0);
  });

  it("filas sin Base (sintéticas legacy): con IVA → subtotal gravado 16%; exento puro → exento", () => {
    const conIva = clasificarBasesIvaEgreso(
      egresoPue({ taxes: [{ tipo: "IVA", factor: "TASA", tasa: 0.16, base: null, importe: 160, retencion: false }] })
    );
    expect(conIva.base16).toBe(1000);
    expect(conIva.iva).toBe(160);

    const exento = clasificarBasesIvaEgreso(
      egresoPue({
        subtotal: 1000,
        total: 1000,
        totalImpuestos: 0,
        taxes: [{ tipo: "IVA", factor: "EXENTO", tasa: 0, base: null, importe: 0, retencion: false }],
      })
    );
    expect(exento.exentos).toBe(1000);
    expect(exento.base0).toBe(0);
  });
});
