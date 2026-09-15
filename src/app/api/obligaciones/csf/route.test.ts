import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  membership: vi.fn(),
  textoDePdf: vi.fn(),
  parsearTextoCsf: vi.fn(),
  mapCsfObligacion: vi.fn(),
  companyFindUnique: vi.fn(),
  obligationFindUnique: vi.fn(),
  obligationUpdate: vi.fn(),
  obligationCreate: vi.fn(),
  obligationUpsert: vi.fn(),
  transaction: vi.fn(),
  regimenUpdateMany: vi.fn(),
  regimenUpsert: vi.fn(),
  companyUpdate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/authz", () => ({ getEffectiveCompanyMembership: mocks.membership }));
vi.mock("@/lib/fiscal/fuentes/texto", () => ({ textoDePdf: mocks.textoDePdf }));
vi.mock("@/lib/obligaciones", () => ({
  parsearTextoCsf: mocks.parsearTextoCsf,
  mapCsfObligacion: mocks.mapCsfObligacion,
  REGIMEN_MAP: {},
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    company: { findUnique: mocks.companyFindUnique },
    companyObligation: {
      findUnique: mocks.obligationFindUnique,
      update: mocks.obligationUpdate,
      create: mocks.obligationCreate,
      upsert: mocks.obligationUpsert,
    },
    $transaction: mocks.transaction,
  },
}));

import { POST } from "./route";

const request = (extra: Record<string, unknown> = {}) => new Request(
  "http://localhost/api/obligaciones/csf",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      companyId: "company-1",
      csfBase64: Buffer.from("pdf").toString("base64"),
      ...extra,
    }),
  },
);

describe("POST /api/obligaciones/csf regime sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
    mocks.membership.mockResolvedValue({ role: "OWNER" });
    mocks.textoDePdf.mockResolvedValue("parsed by mock");
    mocks.mapCsfObligacion.mockReturnValue(null);
    mocks.regimenUpdateMany.mockResolvedValue({ count: 1 });
    mocks.regimenUpsert.mockResolvedValue({});
    mocks.companyUpdate.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (callback) => callback({
      companyRegimen: {
        updateMany: mocks.regimenUpdateMany,
        upsert: mocks.regimenUpsert,
      },
      company: { update: mocks.companyUpdate },
    }));
  });

  it("atomically activates the current CSF set and ends a missing regime", async () => {
    mocks.parsearTextoCsf.mockReturnValue({
      rfc: "AAAA010101AAA",
      codigoPostal: "72000",
      regimenes: [
        { codigo: "605", nombre: "Sueldos", desde: "01/01/2024" },
        { codigo: "612", nombre: "Actividad empresarial", desde: "02/02/2024" },
      ],
      obligaciones: [],
    });
    mocks.companyFindUnique.mockResolvedValue({
      rfc: "AAAA010101AAA",
      regimenFiscal: "612",
      codigoPostal: "72100",
      regimenes: [
        { code: "612", label: "Actividad empresarial", since: null, isPrimary: true, active: true },
        { code: "606", label: "Arrendamiento", since: null, isPrimary: false, active: true },
      ],
    });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cambios).toEqual(expect.arrayContaining([
      "regímenes activados: 605",
      "regímenes terminados: 606",
      "CP 72100 → 72000",
    ]));
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.regimenUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { companyId: "company-1" },
      data: { isPrimary: false },
    });
    expect(mocks.regimenUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { companyId: "company-1", code: { in: ["606"] }, active: true },
      data: { active: false, endedAt: expect.any(Date) },
    });
    expect(mocks.regimenUpsert).toHaveBeenCalledTimes(2);
    expect(mocks.companyUpdate).toHaveBeenCalledWith({
      where: { id: "company-1" },
      data: { regimenFiscal: "612", codigoPostal: "72000" },
    });
  });

  it("makes no writes when a replaced multi-regime set needs a primary choice", async () => {
    mocks.parsearTextoCsf.mockReturnValue({
      rfc: "AAAA010101AAA",
      regimenes: [
        { codigo: "605", nombre: "Sueldos", desde: "" },
        { codigo: "612", nombre: "Actividad empresarial", desde: "" },
      ],
      obligaciones: [],
    });
    mocks.companyFindUnique.mockResolvedValue({
      rfc: "AAAA010101AAA",
      regimenFiscal: "626",
      codigoPostal: "72100",
      regimenes: [
        { code: "626", label: "RESICO", since: null, isPrimary: true, active: true },
      ],
    });

    const response = await POST(request());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "PRIMARY_REQUIRED",
      regimenes: [
        { codigo: "605", nombre: "Sueldos", desde: "" },
        { codigo: "612", nombre: "Actividad empresarial", desde: "" },
      ],
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.obligationFindUnique).not.toHaveBeenCalled();
    expect(mocks.obligationUpsert).not.toHaveBeenCalled();
  });

  it("uses an explicit primary to resolve a replaced multi-regime set", async () => {
    mocks.parsearTextoCsf.mockReturnValue({
      rfc: "AAAA010101AAA",
      regimenes: [
        { codigo: "605", nombre: "Sueldos", desde: "" },
        { codigo: "612", nombre: "Actividad empresarial", desde: "" },
      ],
      obligaciones: [],
    });
    mocks.companyFindUnique.mockResolvedValue({
      rfc: "AAAA010101AAA",
      regimenFiscal: "626",
      codigoPostal: "72100",
      regimenes: [
        { code: "626", label: "RESICO", since: null, isPrimary: true, active: true },
      ],
    });

    const response = await POST(request({ regimenFiscalPrincipal: "605" }));

    expect(response.status).toBe(200);
    expect(mocks.regimenUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ isPrimary: true }),
      create: expect.objectContaining({ code: "605", isPrimary: true }),
    }));
    expect(mocks.companyUpdate).toHaveBeenCalledWith({
      where: { id: "company-1" },
      data: { regimenFiscal: "605" },
    });
  });
});
