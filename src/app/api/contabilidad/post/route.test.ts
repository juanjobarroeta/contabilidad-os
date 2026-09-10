import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWriter: vi.fn(),
  postMonth: vi.fn(),
  unpostMonth: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  AuthzError: class AuthzError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
  requireWriter: mocks.requireWriter,
}));

vi.mock("@/lib/contabilidad/posting", () => {
  class PeriodoNoContabilizableError extends Error {
    readonly status = 409;
    readonly code = "CIERRE_NO_CONTABILIZABLE";
    constructor(message: string, readonly estado: unknown) {
      super(message);
    }
  }
  return {
    PeriodoNoContabilizableError,
    postMonth: mocks.postMonth,
    unpostMonth: mocks.unpostMonth,
  };
});

vi.mock("@/lib/contabilidad/ejercicio", () => ({
  PeriodoCerradoError: class PeriodoCerradoError extends Error {
    readonly status = 409;
  },
}));

import { PeriodoNoContabilizableError } from "@/lib/contabilidad/posting";
import { POST } from "./route";

describe("POST /api/contabilidad/post — compuerta canónica", () => {
  beforeEach(() => vi.clearAllMocks());

  it("devuelve el 409 estructurado del motor", async () => {
    const estado = {
      fase: "BLOQUEADO" as const,
      estadoContable: "DRAFT" as const,
      declarado: false,
      origenCierre: null,
      listo: false,
      contabilizado: false,
      cerrado: false,
      descargable: false,
      puedeContabilizar: false,
      bloqueos: [
        {
          paso: "banco" as const,
          titulo: "Bancos",
          tipo: "MOTOR" as const,
          detalle: "3 movimientos sin conciliar",
        },
      ],
    };
    mocks.postMonth.mockRejectedValue(
      new PeriodoNoContabilizableError(
        "El periodo tiene bloqueos activos: 3 movimientos sin conciliar",
        estado
      )
    );

    const res = await POST(
      new Request("http://localhost/api/contabilidad/post", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyId: "empresa", year: 2026, month: 8 }),
      })
    );

    expect(res.status).toBe(409);
    expect(mocks.requireWriter).toHaveBeenCalledWith("empresa");
    await expect(res.json()).resolves.toEqual({
      code: "CIERRE_NO_CONTABILIZABLE",
      error: "El periodo tiene bloqueos activos: 3 movimientos sin conciliar",
      estado,
    });
  });
});
