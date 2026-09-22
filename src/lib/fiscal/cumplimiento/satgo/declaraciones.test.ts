import { describe, it, expect } from "vitest";
import { filasDeAcuse, periodoDeArchivo } from "./declaraciones";
import type { AcuseMensual } from "@/lib/fiscal/acuse/parse";

const base: AcuseMensual = {
  rfc: "CPM2307076Z9", periodoMes: 8, periodoAnio: 2026, tipoImpuesto: "IVA_ISR", tipoPago: "PROVISIONAL",
  ivaCausado: 351014, ivaAcreditable: 293236, ivaAPagar: 14956, ivaAFavor: null, ivaSaldoFavorAplicado: 42822,
  isrIngresos: 27343774, isrRetenciones: 0, isrPagosAnteriores: 0, isrAPagar: 0, coeficienteUtilidadAplicado: 0,
  retencionesSalarios: 45175, retencionesTerceros: null,
  iepsAPagar: null, iepsAFavor: null, lineaCaptura: null, fechaPresentacion: "2026-09-17",
};

describe("filasDeAcuse", () => {
  it("las retenciones de nómina van a su fila, no al ISR propio", () => {
    const filas = filasDeAcuse(base, new Set(["IVA_MENSUAL", "ISR_PROVISIONAL", "RETENCIONES_ISR"]));
    expect(filas.map((f) => f.tipo)).toEqual(["IVA_MENSUAL", "ISR_PROVISIONAL", "RETENCIONES_ISR"]);
    expect(filas.find((f) => f.tipo === "ISR_PROVISIONAL")?.data.isrPagar).toBe(0);
    expect(filas.find((f) => f.tipo === "RETENCIONES_ISR")?.data.retencionesIsr).toBe(45175);
  });

  it("sin renglón de retenciones no inventa la fila; sólo crea lo que falta", () => {
    const filas = filasDeAcuse({ ...base, retencionesSalarios: null }, new Set(["RETENCIONES_ISR", "IEPS_MENSUAL"]));
    expect(filas).toEqual([]);
  });
});

describe("periodoDeArchivo", () => {
  it("Normal_2026_Agosto.pdf → 2026-08", () => {
    expect(periodoDeArchivo("Normal_2026_Agosto.pdf")).toEqual({ periodo: "2026-08", tipoPago: "NORMAL" });
    expect(periodoDeArchivo("Complementaria_2025_Diciembre.pdf")).toEqual({ periodo: "2025-12", tipoPago: "COMPLEMENTARIA" });
    expect(periodoDeArchivo("acuse-2026-07.pdf")?.periodo).toBe("2026-07");
    expect(periodoDeArchivo("otro.pdf")).toBeNull();
  });
});
