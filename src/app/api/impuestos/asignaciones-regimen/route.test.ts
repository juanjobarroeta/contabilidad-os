import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  membership: vi.fn(),
  companyFindUnique: vi.fn(),
  invoiceFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/authz", () => ({ getEffectiveCompanyMembership: mocks.membership }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    company: { findUnique: mocks.companyFindUnique },
    invoice: { findMany: mocks.invoiceFindMany },
  },
}));

import { GET } from "./route";

const request = (query = "companyId=company-1&year=2026&month=8") =>
  new Request(`http://localhost/api/impuestos/asignaciones-regimen?${query}`);

const lifecycle = [
  { code: "612", since: new Date("2024-01-01T00:00:00.000Z"), endedAt: null, active: true },
  { code: "606", since: new Date("2025-01-01T00:00:00.000Z"), endedAt: null, active: true },
];

function invoice(params: {
  id: string;
  assignment?: { allocations: { regimenCode: string; basisPoints: number }[] } | null;
}) {
  return {
    id: params.id,
    tipo: "INGRESO",
    fecha: new Date("2026-08-10T12:00:00.000Z"),
    serie: "A",
    folio: "42",
    uuid: `uuid-${params.id}`,
    contraparteNombre: "Cliente del CFDI",
    contraparteRfc: "XAXX010101000",
    total: 1160,
    customer: null,
    regimenAssignment: params.assignment ?? null,
  };
}

describe("GET /api/impuestos/asignaciones-regimen", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
    mocks.membership.mockResolvedValue({ role: "VIEWER" });
    mocks.companyFindUnique.mockResolvedValue({ regimenFiscal: "612", regimenes: lifecycle });
    mocks.invoiceFindMany.mockResolvedValue([]);
  });

  it("returns 401 before reading fiscal data", async () => {
    mocks.auth.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.companyFindUnique).not.toHaveBeenCalled();
  });

  it("validates the canonical monthly period", async () => {
    const response = await GET(request("companyId=company-1&year=2026&month=13"));

    expect(response.status).toBe(400);
    expect(mocks.membership).not.toHaveBeenCalled();
  });

  it("requires company membership", async () => {
    mocks.membership.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mocks.companyFindUnique).not.toHaveBeenCalled();
  });

  it("queries only stamped income and expense CFDIs in the UTC month", async () => {
    await GET(request());

    expect(mocks.invoiceFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        companyId: "company-1",
        tipo: { in: ["INGRESO", "EGRESO"] },
        status: "STAMPED",
        fecha: {
          gte: new Date("2026-08-01T00:00:00.000Z"),
          lt: new Date("2026-09-01T00:00:00.000Z"),
        },
      },
    }));
  });

  it("returns the complete period queue without enabling calculations", async () => {
    mocks.invoiceFindMany.mockResolvedValue([
      invoice({ id: "missing" }),
      invoice({
        id: "complete",
        assignment: { allocations: [
          { regimenCode: "612", basisPoints: 6_000 },
          { regimenCode: "606", basisPoints: 4_000 },
        ] },
      }),
      invoice({
        id: "stale",
        assignment: { allocations: [{ regimenCode: "626", basisPoints: 10_000 }] },
      }),
    ]);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      periodo: "2026-08",
      estado: "PENDIENTE",
      requiereAsignacion: true,
      evidenciaCompleta: false,
      resumen: { total: 3, completas: 1, sinAsignar: 1, requierenRevision: 1 },
      facturasPendientes: [
        { id: "missing", estado: "SIN_ASIGNAR", total: 1160 },
        {
          id: "stale",
          estado: "REQUIERE_REVISION",
          observacion: { code: "REGIME_OUTSIDE_PERIOD" },
        },
      ],
      alcance: "CFDI_TIMBRADOS_EMITIDOS_O_RECIBIDOS_EN_EL_MES",
      usadaEnCalculoAutomatico: false,
    });
    expect(body.limitaciones).toEqual(expect.arrayContaining([
      expect.stringContaining("PPD"),
      expect.stringContaining("No separa IVA"),
    ]));
  });

  it("stays hidden from the review workflow for a single-regime month", async () => {
    mocks.companyFindUnique.mockResolvedValue({
      regimenFiscal: "612",
      regimenes: [lifecycle[0]],
    });

    const response = await GET(request());

    await expect(response.json()).resolves.toMatchObject({
      estado: "NO_REQUIERE_ASIGNACION",
      requiereAsignacion: false,
      evidenciaCompleta: true,
      facturasPendientes: [],
      usadaEnCalculoAutomatico: false,
    });
    expect(mocks.invoiceFindMany).not.toHaveBeenCalled();
  });

  it("fails closed without scanning invoices when a regime code is unknown", async () => {
    mocks.companyFindUnique.mockResolvedValue({
      regimenFiscal: "612",
      regimenes: [lifecycle[0], { ...lifecycle[1], code: "999" }],
    });

    const response = await GET(request());

    await expect(response.json()).resolves.toMatchObject({
      estado: "REGIMEN_NO_RECONOCIDO",
      evidenciaCompleta: false,
      regimenesNoReconocidos: ["999"],
    });
    expect(mocks.invoiceFindMany).not.toHaveBeenCalled();
  });

  it("bounds the pending preview while preserving exact whole-period counts", async () => {
    mocks.invoiceFindMany.mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => invoice({ id: `missing-${index + 1}` })),
    );

    const response = await GET(request());
    const body = await response.json();

    expect(body.resumen).toMatchObject({ total: 30, sinAsignar: 30 });
    expect(body.facturasPendientes).toHaveLength(25);
    expect(body.facturasPendientes[0]).toMatchObject({ id: "missing-1" });
    expect(body.facturasPendientes[24]).toMatchObject({ id: "missing-25" });
  });
});
