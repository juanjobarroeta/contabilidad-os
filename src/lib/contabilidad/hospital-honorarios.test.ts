import { describe, expect, it } from "vitest";
import { SIN_HONORARIOS_HOSPITAL, cargarHonorariosHospital, honorariosAlPasivo, type EventoHonorario } from "./hospital-honorarios";

// ─────────────────────────────────────────────────────────────────────────────
// El CFDI con que el médico le factura al hospital cancela el pasivo 205.06
// que dejó el CFDI del paciente; sólo lo que exceda va a gasto. Antes el
// honorario quedaba dos veces: en el pasivo y en resultados.
// ─────────────────────────────────────────────────────────────────────────────

const F = (s: string) => new Date(s);
const VEGA = "VEGA800101AB1";
const RUIZ = "RUIZ750202CD3";

describe("honorariosAlPasivo", () => {
  it("el CFDI del médico cancela lo facturado al paciente por él, en orden, sin pasarse", () => {
    const ev: EventoHonorario[] = [
      { tipo: "FACTURADO", rfc: VEGA, fecha: F("2026-09-05T00:00:00Z"), monto: 18_000 },
      { tipo: "FACTURADO", rfc: VEGA, fecha: F("2026-09-12T00:00:00Z"), monto: 7_000 },
      { tipo: "CFDI_MEDICO", invoiceId: "cfdi-1", rfc: VEGA, fecha: F("2026-09-15T00:00:00Z"), subtotal: 20_000 },
      { tipo: "CFDI_MEDICO", invoiceId: "cfdi-2", rfc: VEGA, fecha: F("2026-09-30T00:00:00Z"), subtotal: 8_000 },
    ];
    const r = honorariosAlPasivo(ev);
    expect(r.get("cfdi-1")).toBe(20_000);
    // Quedaban 5,000 en el pasivo: los otros 3,000 siguen a gasto.
    expect(r.get("cfdi-2")).toBe(5_000);
  });

  it("el médico que facturó antes de que el hospital cobrara no encuentra pasivo", () => {
    const r = honorariosAlPasivo([
      { tipo: "CFDI_MEDICO", invoiceId: "cfdi-1", rfc: VEGA, fecha: F("2026-09-01T00:00:00Z"), subtotal: 10_000 },
      { tipo: "FACTURADO", rfc: VEGA, fecha: F("2026-09-02T00:00:00Z"), monto: 10_000 },
    ]);
    expect(r.get("cfdi-1")).toBe(0);
  });

  it("el mismo día, lo facturado al paciente cuenta antes que el CFDI del médico", () => {
    const r = honorariosAlPasivo([
      { tipo: "CFDI_MEDICO", invoiceId: "cfdi-1", rfc: VEGA, fecha: F("2026-09-05T00:00:00Z"), subtotal: 10_000 },
      { tipo: "FACTURADO", rfc: VEGA, fecha: F("2026-09-05T00:00:00Z"), monto: 10_000 },
    ]);
    expect(r.get("cfdi-1")).toBe(10_000);
  });

  it("cada médico con su propio pasivo; el RFC no distingue mayúsculas", () => {
    const r = honorariosAlPasivo([
      { tipo: "FACTURADO", rfc: VEGA, fecha: F("2026-09-05T00:00:00Z"), monto: 10_000 },
      { tipo: "CFDI_MEDICO", invoiceId: "ruiz", rfc: RUIZ, fecha: F("2026-09-06T00:00:00Z"), subtotal: 4_000 },
      { tipo: "CFDI_MEDICO", invoiceId: "vega", rfc: VEGA.toLowerCase(), fecha: F("2026-09-06T00:00:00Z"), subtotal: 4_000 },
    ]);
    expect(r.get("ruiz")).toBe(0);
    expect(r.get("vega")).toBe(4_000);
  });
});

describe("cargarHonorariosHospital", () => {
  it("con la contabilidad del hospital apagada, contexto vacío: el CFDI del médico sigue a gasto como siempre", async () => {
    const db: any = {
      hospConfig: { findUnique: async () => ({ contabilidadActiva: false, cuentasContables: null }) },
      company: { findUnique: async () => ({ rfc: "CPM2307076Z9" }) },
    };
    const ctx = await cargarHonorariosHospital("c1", { start: F("2026-09-01T00:00:00Z"), end: F("2026-10-01T00:00:00Z") }, { db });
    expect(ctx).toBe(SIN_HONORARIOS_HOSPITAL);
  });

  it("encendida: sólo los CFDIs del mes que encontraron pasivo; los demás quedan señalados", async () => {
    const db: any = {
      hospConfig: { findUnique: async () => ({ contabilidadActiva: true, cuentasContables: null }) },
      company: { findUnique: async () => ({ rfc: "CPM2307076Z9" }) },
      hospMedico: { findMany: async () => [{ id: "m1", rfc: VEGA, supplier: null }, { id: "m2", rfc: null, supplier: { rfc: RUIZ } }] },
      hospCargo: {
        findMany: async () => [
          { medicoId: "m1", importe: 18_000, invoice: { fecha: F("2026-08-20T00:00:00Z") } },
          { medicoId: "m1", importe: 5_000, invoice: { fecha: F("2026-09-10T00:00:00Z") } },
        ],
      },
      invoice: {
        findMany: async () => [
          { id: "agosto", fecha: F("2026-08-25T00:00:00Z"), subtotal: 18_000, contraparteRfc: VEGA, customer: null },
          { id: "sept-vega", fecha: F("2026-09-15T00:00:00Z"), subtotal: 5_000, contraparteRfc: null, customer: { rfc: VEGA } },
          { id: "sept-ruiz", fecha: F("2026-09-16T00:00:00Z"), subtotal: 3_000, contraparteRfc: RUIZ, customer: null },
        ],
      },
      postingCuentaOverride: { findUnique: async () => null },
      chartAccount: { findMany: async () => [{ id: "cta-205", cuentaSAT: "205", subcuenta: "205.06", nombre: "Acreedores diversos", tipo: "PASIVO" }] },
    };
    const ctx = await cargarHonorariosHospital("c1", { start: F("2026-09-01T00:00:00Z"), end: F("2026-10-01T00:00:00Z") }, { db });
    expect(ctx.activa).toBe(true);
    // Agosto ya consumió los 18,000 de agosto; septiembre cancela los 5,000 nuevos.
    expect([...ctx.porInvoice.entries()]).toEqual([["sept-vega", 5_000]]);
    expect([...ctx.sinPasivo]).toEqual(["sept-ruiz"]);
    expect(ctx.cuenta).toEqual({ id: "cta-205" });
  });
});
