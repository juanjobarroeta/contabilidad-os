import { describe, it, expect } from "vitest";
import { clasificarSlot } from "./deprovision";

describe("clasificarSlot", () => {
  it("empresa activa con pago vigente y plan con Syntage → conservar", () => {
    expect(
      clasificarSlot({ existe: true, tieneFiel: true, incluyeSyntage: true, pagoVigente: true })
    ).toEqual({ accion: "conservar", motivo: "activa", borrarEntidad: false });
  });

  it("RFC sin Company local (baja definitiva) → liberar credenciales Y entidad", () => {
    expect(clasificarSlot({ existe: false })).toEqual({
      accion: "liberar",
      motivo: "huerfana",
      borrarEntidad: true,
    });
  });

  it("empresa sin e.firma guardada → liberar sólo credenciales", () => {
    expect(
      clasificarSlot({ existe: true, tieneFiel: false, incluyeSyntage: true, pagoVigente: true })
    ).toEqual({ accion: "liberar", motivo: "sin_fiel", borrarEntidad: false });
  });

  it("tier sin Syntage (ASISTENTE) → liberar sólo credenciales", () => {
    expect(
      clasificarSlot({ existe: true, tieneFiel: true, incluyeSyntage: false, pagoVigente: true })
    ).toEqual({ accion: "liberar", motivo: "plan_sin_syntage", borrarEntidad: false });
  });

  it("ningún pagador vigente (cliente dejó de pagar) → liberar sólo credenciales", () => {
    expect(
      clasificarSlot({ existe: true, tieneFiel: true, incluyeSyntage: true, pagoVigente: false })
    ).toEqual({ accion: "liberar", motivo: "sin_pago", borrarEntidad: false });
  });
});
