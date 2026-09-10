import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  companyFindUnique: vi.fn(),
  evaluarCierre: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  AuthzError: class AuthzError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
  requireMembership: mocks.requireMembership,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    company: { findUnique: mocks.companyFindUnique },
  },
}));

vi.mock("@/lib/cierre/evaluar", () => ({ evaluarCierre: mocks.evaluarCierre }));

import { GET } from "./route";

describe("GET /api/contabilidad/paquete — compuerta canónica", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.companyFindUnique.mockResolvedValue({ rfc: "AAA010101AAA", razonSocial: "ACME" });
  });

  it("no entrega un paquete preliminar aunque no haya bloqueo", async () => {
    mocks.evaluarCierre.mockResolvedValue({
      estado: {
        fase: "LISTO",
        estadoContable: "DRAFT",
        declarado: false,
        origenCierre: null,
        listo: true,
        contabilizado: false,
        cerrado: false,
        descargable: false,
        puedeContabilizar: true,
        bloqueos: [],
      },
    });

    const res = await GET(new Request("http://localhost/api/contabilidad/paquete?companyId=c1&year=2026&month=8"));
    expect(res.status).toBe(409);
    expect(mocks.evaluarCierre).toHaveBeenCalledWith("c1", 2026, 8, { fresco: true });
    await expect(res.json()).resolves.toMatchObject({
      code: "CIERRE_NO_DESCARGABLE",
      estado: { fase: "LISTO", descargable: false },
    });
  });

  it("un bloqueo vigente gana sobre un ledger físicamente cerrado", async () => {
    mocks.evaluarCierre.mockResolvedValue({
      estado: {
        fase: "BLOQUEADO",
        estadoContable: "CLOSED",
        declarado: true,
        origenCierre: null,
        listo: false,
        contabilizado: false,
        cerrado: false,
        descargable: false,
        puedeContabilizar: false,
        bloqueos: [
          { paso: "banco", titulo: "Bancos", tipo: "MOTOR", detalle: "Sin estado de cuenta" },
        ],
      },
    });

    const res = await GET(new Request("http://localhost/api/contabilidad/paquete?companyId=c1&year=2026&month=8"));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "CIERRE_NO_DESCARGABLE",
      error: expect.stringContaining("Sin estado de cuenta"),
      estado: { fase: "BLOQUEADO", estadoContable: "CLOSED" },
    });
  });

  it("un cierre histórico externo no inventa el paquete contable", async () => {
    mocks.evaluarCierre.mockResolvedValue({
      estado: {
        fase: "CERRADO",
        estadoContable: null,
        declarado: true,
        origenCierre: "FUERA_DE_CONTABILIDAD_OS",
        listo: true,
        contabilizado: false,
        cerrado: true,
        descargable: false,
        puedeContabilizar: true,
        bloqueos: [],
      },
    });

    const res = await GET(new Request("http://localhost/api/contabilidad/paquete?companyId=c1&year=2026&month=7"));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "CIERRE_NO_DESCARGABLE",
      estado: { fase: "CERRADO", origenCierre: "FUERA_DE_CONTABILIDAD_OS", descargable: false },
    });
  });
});
