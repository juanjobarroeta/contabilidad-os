import { describe, expect, it } from "vitest";
import {
  DisponibleHospital,
  SIN_COBRO_BANCO_HOSPITAL,
  cargarContextoCobroBancoHospital,
  partirCobroHospital,
} from "./hospital-cobro-banco";
import { patasDeCobro, REGENERATED_SOURCES } from "./posting";

// ─────────────────────────────────────────────────────────────────────────────
// El depósito bancario de un cobro que la caja del hospital ya asentó: el abono
// sale de 107.05 (o CAJA) por lo que ella dejó pendiente y sólo el resto va a
// CLIENTES. Antes CLIENTES se abonaba dos veces y 107.05 no bajaba nunca.
// ─────────────────────────────────────────────────────────────────────────────

const F = (s: string) => new Date(s);
const CTAS = { banco: "bancos", transito: "107.05", clientes: "105.01", anticipos: "206.01", caja: "101.01" };

/** Saldo neto de una cuenta en un juego de patas (cargo +, abono −). */
const neto = (patas: { chartAccountId: string; monto: number; tipo: string }[], cuenta: string) =>
  Math.round(patas.filter((p) => p.chartAccountId === cuenta).reduce((s, p) => s + (p.tipo === "CARGO" ? p.monto : -p.monto), 0) * 100) / 100;

function patasCompletas(opts: { absAmount: number; asignado: number; sobrante: number; cubierto: number; enEfectivo?: boolean }) {
  const hosp = partirCobroHospital({ ...opts, ctaBancoId: CTAS.banco, ctaCajaHospitalId: opts.enEfectivo ? CTAS.caja : CTAS.transito });
  const resto =
    hosp.resto.absAmount > 0.005
      ? patasDeCobro({
          enEfectivo: !!opts.enEfectivo,
          ctaBancoId: CTAS.banco,
          ctaCajaId: CTAS.caja,
          ctaCobroId: CTAS.clientes,
          ctaAnticiposId: CTAS.anticipos,
          ...hosp.resto,
        })
      : [];
  return [...hosp.patas, ...resto];
}

describe("DisponibleHospital", () => {
  it("el saldo a la fecha del depósito, sin lo que ya consumieron depósitos anteriores; nunca negativo", () => {
    const d = new DisponibleHospital(
      { transito: 1000, caja: 0 },
      { transito: [{ fecha: F("2026-09-05T00:00:00Z"), delta: 500 }, { fecha: F("2026-09-20T00:00:00Z"), delta: 700 }], caja: [] },
    );
    expect(d.disponible("transito", F("2026-09-10T00:00:00Z"))).toBe(1500);
    expect(d.cubrir("transito", F("2026-09-10T00:00:00Z"), 1200)).toBe(1200);
    expect(d.disponible("transito", F("2026-09-10T00:00:00Z"))).toBe(300);
    // El cobro del 20 todavía no existía el 10: no cuenta hasta su fecha.
    expect(d.cubrir("transito", F("2026-09-12T00:00:00Z"), 1000)).toBe(300);
    expect(d.cubrir("transito", F("2026-09-21T00:00:00Z"), 1000)).toBe(700);
    expect(d.cubrir("transito", F("2026-09-30T00:00:00Z"), 1000)).toBe(0);
    expect(d.cubrir("caja", F("2026-09-30T00:00:00Z"), 1000)).toBe(0);
  });
});

describe("partirCobroHospital", () => {
  it("todo lo cobró la caja: DR Bancos / AB 107.05 y CLIENTES no se toca", () => {
    const p = patasCompletas({ absAmount: 10_000, asignado: 10_000, sobrante: 0, cubierto: 10_000 });
    expect(neto(p, CTAS.banco)).toBe(10_000);
    expect(neto(p, CTAS.transito)).toBe(-10_000);
    expect(neto(p, CTAS.clientes)).toBe(0);
  });

  it("parte lo cobró la caja y parte es cobranza previa: 107.05 por lo que alcanza, CLIENTES por el resto", () => {
    const p = patasCompletas({ absAmount: 10_000, asignado: 10_000, sobrante: 0, cubierto: 4_000 });
    expect(neto(p, CTAS.banco)).toBe(10_000);
    expect(neto(p, CTAS.transito)).toBe(-4_000);
    expect(neto(p, CTAS.clientes)).toBe(-6_000);
  });

  it("lo cubierto sale primero de lo asignado y luego del sobrante (anticipos)", () => {
    const p = patasCompletas({ absAmount: 10_000, asignado: 3_000, sobrante: 7_000, cubierto: 5_000 });
    expect(neto(p, CTAS.transito)).toBe(-5_000);
    expect(neto(p, CTAS.clientes)).toBe(0);
    expect(neto(p, CTAS.anticipos)).toBe(-5_000);
  });

  it("efectivo que la caja ya asentó: DR Bancos / AB CAJA, sin volver a abonar CLIENTES", () => {
    const p = patasCompletas({ absAmount: 2_000, asignado: 2_000, sobrante: 0, cubierto: 2_000, enEfectivo: true });
    expect(neto(p, CTAS.banco)).toBe(2_000);
    expect(neto(p, CTAS.caja)).toBe(-2_000);
    expect(neto(p, CTAS.clientes)).toBe(0);
  });

  it("sin caja del hospital (cubierto 0) las patas son exactamente las de siempre", () => {
    const antes = patasDeCobro({ enEfectivo: false, ctaBancoId: CTAS.banco, ctaCajaId: CTAS.caja, ctaCobroId: CTAS.clientes, ctaAnticiposId: CTAS.anticipos, absAmount: 10_000, asignado: 8_000, sobrante: 2_000 });
    expect(patasCompletas({ absAmount: 10_000, asignado: 8_000, sobrante: 2_000, cubierto: 0 })).toEqual(antes);
  });

  it("las patas siempre cuadran", () => {
    for (const cubierto of [0, 1, 2_999.99, 5_000, 10_000]) {
      for (const enEfectivo of [false, true]) {
        const p = patasCompletas({ absAmount: 10_000, asignado: 6_000, sobrante: 4_000, cubierto, enEfectivo });
        const cargos = p.filter((x) => x.tipo === "CARGO").reduce((s, x) => s + x.monto, 0);
        const abonos = p.filter((x) => x.tipo === "ABONO").reduce((s, x) => s + x.monto, 0);
        expect(Math.round((cargos - abonos) * 100)).toBe(0);
      }
    }
  });
});

describe("cargarContextoCobroBancoHospital", () => {
  it("con la contabilidad del hospital apagada, contexto vacío: el motor no cambia", async () => {
    const db: any = {
      hospConfig: { findUnique: async () => ({ contabilidadActiva: false, cuentasContables: null }) },
      company: { findUnique: async () => ({ rfc: "CPM2307076Z9" }) },
    };
    const ctx = await cargarContextoCobroBancoHospital(
      "c1",
      { year: 2026, month: 9, start: F("2026-09-01T00:00:00Z"), end: F("2026-10-01T00:00:00Z") },
      REGENERATED_SOURCES,
      { db },
    );
    expect(ctx).toBe(SIN_COBRO_BANCO_HOSPITAL);
  });
});
