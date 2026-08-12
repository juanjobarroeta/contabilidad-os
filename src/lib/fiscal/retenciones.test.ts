import { describe, it, expect } from "vitest";
import { armarRetenciones, type InsumosRetenciones } from "./retenciones";

// ─────────────────────────────────────────────────────────────────────────────
// El entero del día 17 no admite «se ve bien»: casos fijos sobre el armado.
// ─────────────────────────────────────────────────────────────────────────────

const base = (o: Partial<InsumosRetenciones> = {}): InsumosRetenciones => ({
  year: 2026,
  month: 7,
  sueldos: { isrRetenido: 0, recibos: 0 },
  asimilados: { isrRetenido: 0, recibos: 0 },
  retencionesAProveedores: [],
  retencionesDeClientes: [],
  ...o,
});

const cfdi = (taxes: Array<[string, number]>, tipoSat: string | null = "I") => ({
  tipoSat,
  taxes: taxes.map(([tipo, importe]) => ({ tipo, importe })),
});

describe("armarRetenciones()", () => {
  it("suma lo que la empresa retuvo como retenedor, por concepto", () => {
    const r = armarRetenciones(
      base({
        sueldos: { isrRetenido: 482_310.55, recibos: 618 },
        asimilados: { isrRetenido: 12_000, recibos: 4 },
        retencionesAProveedores: [
          cfdi([["ISR", 1_000], ["IVA", 1_066.67]]), // honorarios PF
          cfdi([["IVA", 400]]), // flete 4%
        ],
      })
    );
    expect(r.aEnterar).toBe(496_777.22);
    expect(r.recibosNomina).toBe(622);
    expect(r.conceptos.map((c) => [c.clave, c.monto])).toEqual([
      ["isr_sueldos", 482_310.55],
      ["isr_asimilados", 12_000],
      ["isr_proveedores", 1_000],
      ["iva_proveedores", 1_466.67],
    ]);
    // El conteo es de CFDIs que traen ESE impuesto, no de todos los recibidos.
    expect(r.conceptos.find((c) => c.clave === "isr_proveedores")?.comprobantes).toBe(1);
    expect(r.conceptos.find((c) => c.clave === "iva_proveedores")?.comprobantes).toBe(2);
  });

  it("una nota de crédito recibida BAJA la retención, no la sube", () => {
    const r = armarRetenciones(
      base({
        retencionesAProveedores: [cfdi([["IVA", 1_066.67]]), cfdi([["IVA", 266.67]], "E")],
      })
    );
    expect(r.conceptos.find((c) => c.clave === "iva_proveedores")?.monto).toBe(800);
  });

  it("lo que los CLIENTES retuvieron no es un pasivo: va aparte, no al entero", () => {
    const r = armarRetenciones(
      base({
        sueldos: { isrRetenido: 5_000, recibos: 10 },
        retencionesDeClientes: [cfdi([["IVA", 3_200], ["ISR", 2_000]])],
      })
    );
    expect(r.aEnterar).toBe(5_000); // no incluye lo retenido por clientes
    expect(r.aFavor).toEqual({ iva: 3_200, isr: 2_000 });
  });

  it("un concepto sin comprobantes ni monto no ensucia la declaración", () => {
    const r = armarRetenciones(base({ sueldos: { isrRetenido: 5_000, recibos: 10 } }));
    expect(r.conceptos.map((c) => c.clave)).toEqual(["isr_sueldos"]);
    expect(r.aEnterar).toBe(5_000);
  });

  it("un periodo con recibos pero sin ISR retenido SÍ se muestra (en cero, con respaldo)", () => {
    // Nómina baja del salario mínimo: retención cero. El renglón debe existir,
    // porque «cero» es una respuesta distinta de «no se calculó».
    const r = armarRetenciones(base({ sueldos: { isrRetenido: 0, recibos: 45 } }));
    expect(r.conceptos).toHaveLength(1);
    expect(r.conceptos[0]).toMatchObject({ clave: "isr_sueldos", monto: 0, comprobantes: 45 });
  });

  it("etiqueta el periodo con dos dígitos de mes", () => {
    expect(armarRetenciones(base({ month: 3 })).periodo).toBe("2026-03");
  });
});
