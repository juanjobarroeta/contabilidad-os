import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  evaluarCompuerta: vi.fn(),
  invalidarCompuerta: vi.fn(),
}));

vi.mock("../cierre/compuerta-contabilizacion", () => ({
  evaluarCompuertaContabilizacion: mocks.evaluarCompuerta,
  invalidarCompuertaContabilizacion: mocks.invalidarCompuerta,
}));

import { PeriodoNoContabilizableError, postMonth } from "./posting";

describe("postMonth — compuerta canónica", () => {
  beforeEach(() => vi.clearAllMocks());

  it("detiene el motor antes de tocar el libro cuando el cierre está bloqueado", async () => {
    const estado = {
      fase: "BLOQUEADO",
      estadoContable: "DRAFT",
      declarado: false,
      origenCierre: null,
      listo: false,
      contabilizado: false,
      cerrado: false,
      descargable: false,
      puedeContabilizar: false,
      bloqueos: [
        {
          paso: "banco",
          titulo: "Bancos",
          tipo: "MOTOR",
          detalle: "3 movimientos sin conciliar",
        },
      ],
    };
    mocks.evaluarCompuerta.mockResolvedValue({
      ok: false,
      status: 409,
      body: {
        code: "CIERRE_NO_CONTABILIZABLE",
        error: "El periodo tiene bloqueos activos: 3 movimientos sin conciliar",
        estado,
      },
    });

    const result = postMonth({ companyId: "empresa", year: 2026, month: 8 });
    await expect(result).rejects.toBeInstanceOf(PeriodoNoContabilizableError);
    await expect(result).rejects.toMatchObject({
      status: 409,
      code: "CIERRE_NO_CONTABILIZABLE",
      estado,
    });
    expect(mocks.evaluarCompuerta).toHaveBeenCalledWith("empresa", 2026, 8);
    expect(mocks.invalidarCompuerta).not.toHaveBeenCalled();
  });
});
