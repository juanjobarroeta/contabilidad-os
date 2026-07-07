import { describe, it, expect } from "vitest";
import { motivoTimbradoNoDisponible } from "./timbrado-candado";

// Decisión pura del candado contra el doble timbrado: sólo una corrida
// CALCULATED y sin timbrado en curso puede reclamarse. La atomicidad de la
// reclamación vive en la base de datos (UPDATE condicional); aquí se prueba
// la regla de negocio que diagnostica el rechazo.

describe("motivoTimbradoNoDisponible", () => {
  it("permite timbrar una corrida CALCULATED sin candado (extraData null)", () => {
    expect(motivoTimbradoNoDisponible({ status: "CALCULATED", extraData: null })).toBeNull();
  });

  it("permite timbrar cuando extraData no trae la clave (corrida nunca timbrada)", () => {
    expect(
      motivoTimbradoNoDisponible({ status: "CALCULATED", extraData: { diasPagados: 15 } })
    ).toBeNull();
  });

  it("permite timbrar cuando stampingInProgress quedó en false (timbrado previo liberado)", () => {
    expect(
      motivoTimbradoNoDisponible({
        status: "CALCULATED",
        extraData: { stampingInProgress: false, stampedCount: 3 },
      })
    ).toBeNull();
  });

  it("rechaza cuando otro timbrado está en curso (stampingInProgress = true)", () => {
    const motivo = motivoTimbradoNoDisponible({
      status: "CALCULATED",
      extraData: { stampingInProgress: true, stampedCount: 10 },
    });
    expect(motivo).toMatch(/Timbrado en curso/);
  });

  it("no confunde valores truthy no booleanos con el candado tomado", () => {
    // Sólo el booleano true reclama el candado — un string u otro valor
    // accidental en extraData no debe bloquear el timbrado para siempre.
    expect(
      motivoTimbradoNoDisponible({ status: "CALCULATED", extraData: { stampingInProgress: "sí" } })
    ).toBeNull();
  });

  it.each(["DRAFT", "STAMPED", "PAID"])("rechaza una corrida en estado %s", (status) => {
    const motivo = motivoTimbradoNoDisponible({ status, extraData: null });
    expect(motivo).toContain(`Estado inválido: ${status}`);
    expect(motivo).toContain("CALCULATED");
  });

  it("rechaza por estado aunque no haya timbrado en curso", () => {
    expect(
      motivoTimbradoNoDisponible({
        status: "STAMPED",
        extraData: { stampingInProgress: false },
      })
    ).toMatch(/Estado inválido: STAMPED/);
  });
});
