import { describe, it, expect } from "vitest";
import {
  razonesDeAutoConciliacion,
  senalesEnPalabras,
  tieneIdentidad,
  type CandidatoPuntuado,
  type DecisionConciliacion,
  type SenalesCandidato,
} from "./decision-conciliacion";

const SIN_SENALES: SenalesCandidato = {
  rfcExacto: false,
  rfcEnTexto: false,
  nombre: false,
  folio: false,
  clabeConocida: false,
  importeExacto: false,
  tarjetaContraria: false,
  cercaEnLote: false,
};

function cand(
  invoiceId: string,
  score: number,
  senales: Partial<SenalesCandidato> = {},
): CandidatoPuntuado {
  return {
    invoiceId,
    etiqueta: `Factura ${invoiceId}`,
    score,
    senales: { ...SIN_SENALES, ...senales },
  };
}

function decision(extra: Partial<DecisionConciliacion> = {}): DecisionConciliacion {
  return {
    aplicado: true,
    candidatos: [cand("A", 150, { rfcExacto: true, importeExacto: true })],
    umbral: 130,
    brecha: 20,
    tarjetaLote: null,
    ...extra,
  };
}

const reglas = (d: DecisionConciliacion) => razonesDeAutoConciliacion(d).map((r) => r.regla);

describe("razonesDeAutoConciliacion", () => {
  it("un match aplicado dice con qué se concilió y qué lo identifica", () => {
    const razones = razonesDeAutoConciliacion(decision());
    expect(razones[0].regla).toBe("conciliacion.aplicada");
    expect(razones[0].detalle).toContain("Factura A");
    expect(razones[0].candidatoId).toBe("A");
    expect(reglas(decision())).toContain("conciliacion.identidad");
  });

  it("marca el match que se aplicó SIN saber quién es la contraparte", () => {
    // Es el caso de agosto: cinco facturas del mismo importe en ocho días y un
    // traspaso que se casó con la de otro. Ese renglón hay que poder buscarlo.
    const d = decision({ candidatos: [cand("A", 140, { importeExacto: true })] });
    const razones = razonesDeAutoConciliacion(d);
    const sinIdentidad = razones.find((r) => r.regla === "conciliacion.sin-identidad");
    expect(sinIdentidad).toBeDefined();
    expect(sinIdentidad!.detalle).toContain("importe y fecha");
    expect(reglas(d)).not.toContain("conciliacion.identidad");
  });

  it("el importe exacto NO cuenta como identidad: confirma, no identifica", () => {
    expect(tieneIdentidad({ ...SIN_SENALES, importeExacto: true })).toBe(false);
    expect(tieneIdentidad({ ...SIN_SENALES, rfcExacto: true })).toBe(true);
    expect(tieneIdentidad({ ...SIN_SENALES, clabeConocida: true })).toBe(true);
    expect(tieneIdentidad({ ...SIN_SENALES, folio: true })).toBe(true);
    expect(tieneIdentidad({ ...SIN_SENALES, nombre: true })).toBe(true);
    expect(tieneIdentidad({ ...SIN_SENALES, rfcEnTexto: true })).toBe(true);
  });

  it("nombra las señales de identidad antes que el importe", () => {
    const palabras = senalesEnPalabras({
      ...SIN_SENALES,
      rfcExacto: true,
      importeExacto: true,
    });
    expect(palabras[0]).toContain("RFC");
    expect(palabras[palabras.length - 1]).toContain("importe");
  });

  it("sin candidatos lo dice y no inventa un rechazo por puntaje", () => {
    const razones = razonesDeAutoConciliacion(decision({ aplicado: false, candidatos: [] }));
    expect(razones).toHaveLength(1);
    expect(razones[0].regla).toBe("conciliacion.sin-candidatos");
  });

  it("un rechazo por umbral dice cuánto faltó", () => {
    const d = decision({ aplicado: false, candidatos: [cand("A", 100, { importeExacto: true })] });
    const razones = razonesDeAutoConciliacion(d);
    expect(razones[0].regla).toBe("conciliacion.bajo-umbral");
    expect(razones[0].detalle).toContain("100");
    expect(razones[0].detalle).toContain("130");
  });

  it("un rechazo por ambigüedad explica que adivinar bloquearía al bueno", () => {
    const d = decision({
      aplicado: false,
      candidatos: [
        cand("A", 150, { rfcExacto: true }),
        cand("B", 145, { rfcExacto: true }),
      ],
    });
    const razones = razonesDeAutoConciliacion(d);
    expect(razones[0].regla).toBe("conciliacion.ambiguo");
    expect(razones[0].detalle).toContain("bloquearía");
  });

  it("un match sin segundo candidato lo dice en vez de inventar una brecha", () => {
    expect(reglas(decision())).toContain("conciliacion.candidato-unico");
  });

  it("un match con segundo candidato reporta la distancia contra él", () => {
    const d = decision({
      candidatos: [cand("A", 150, { rfcExacto: true }), cand("B", 100)],
    });
    const razon = razonesDeAutoConciliacion(d).find((r) => r.regla === "conciliacion.sin-ambiguedad");
    expect(razon?.detalle).toContain("50");
  });

  it("nombra la tarjeta del lote y la contraria en español", () => {
    const d = decision({
      candidatos: [cand("A", 150, { rfcExacto: true }), cand("B", 30, { tarjetaContraria: true })],
      tarjetaLote: "CREDITO",
    });
    const razon = razonesDeAutoConciliacion(d).find((r) => r.regla === "terminal.tarjeta-contraria");
    expect(razon?.detalle).toContain("el lote del banco es de crédito");
    expect(razon?.detalle).toContain("la factura declara débito");
  });

  it("explica el descarte por tarjeta aunque no se sepa de qué tarjeta es el lote", () => {
    const d = decision({
      candidatos: [cand("A", 150, { rfcExacto: true }), cand("B", 30, { tarjetaContraria: true })],
      tarjetaLote: null,
    });
    const razon = razonesDeAutoConciliacion(d).find((r) => r.regla === "terminal.tarjeta-contraria");
    expect(razon?.detalle).toContain("contradice");
    expect(razon?.detalle).not.toContain("undefined");
  });

  it("explica cada descarte con SU regla, no con el puntaje genérico", () => {
    const d = decision({
      candidatos: [
        cand("A", 150, { rfcExacto: true }),
        cand("B", 30, { tarjetaContraria: true }),
        cand("C", 60, { cercaEnLote: true }),
        cand("D", 90),
      ],
      tarjetaLote: "CREDITO",
    });
    const porId = new Map(razonesDeAutoConciliacion(d).filter((r) => r.candidatoId).map((r) => [r.candidatoId, r.regla]));
    expect(porId.get("B")).toBe("terminal.tarjeta-contraria");
    expect(porId.get("C")).toBe("terminal.cerca-pero-no-exacto");
    expect(porId.get("D")).toBe("conciliacion.puntaje-menor");
  });

  it("dice cuándo el movimiento es un lote de terminal", () => {
    const razon = razonesDeAutoConciliacion(decision({ tarjetaLote: "DEBITO" })).find(
      (r) => r.regla === "terminal.lote",
    );
    expect(razon?.detalle).toContain("débito");
    expect(razon?.detalle).toContain("varias ventas");
  });

  it("el veredicto va primero: es lo que sobrevive si hay que acotar", () => {
    const d = decision({
      candidatos: [cand("A", 150, { rfcExacto: true }), ...Array.from({ length: 30 }, (_, i) => cand(`x${i}`, 10))],
    });
    expect(razonesDeAutoConciliacion(d)[0].regla).toBe("conciliacion.aplicada");
  });
});
