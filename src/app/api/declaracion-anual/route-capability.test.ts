import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  membership: vi.fn(),
  companyFindUnique: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/authz", () => ({ getEffectiveCompanyMembership: mocks.membership }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    company: { findUnique: mocks.companyFindUnique },
  },
}));

import { GET, POST } from "./route";

const historicalCompany = {
  rfc: "AAAA010101AAA",
  razonSocial: "Empresa histórica",
  regimenFiscal: "612",
  regimenes: [
    {
      code: "608",
      since: new Date("2024-01-01T00:00:00.000Z"),
      endedAt: new Date("2026-09-15T00:00:00.000Z"),
      active: false,
    },
    {
      code: "612",
      since: new Date("2026-01-01T00:00:00.000Z"),
      endedAt: null,
      active: true,
    },
  ],
};

describe("annual declaration period-regime gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
    mocks.membership.mockResolvedValue({ role: "OWNER" });
    mocks.companyFindUnique.mockResolvedValue(historicalCompany);
  });

  it("reads every lifecycle row and gates GET with the requested year's regime", async () => {
    const response = await GET(new Request(
      "http://localhost/api/declaracion-anual?companyId=company-1&ejercicio=2025",
    ));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "NOT_SUPPORTED",
      calculation: "ANNUAL",
      reason: "ASSISTED_ONLY",
      regimen: { code: "608", trackId: "608" },
    });
    expect(mocks.companyFindUnique).toHaveBeenCalledWith({
      where: { id: "company-1" },
      select: {
        rfc: true,
        razonSocial: true,
        regimenFiscal: true,
        regimenes: {
          select: { code: true, since: true, endedAt: true, active: true },
        },
      },
    });
  });

  it("gates POST with the requested year's regime before persisting", async () => {
    const response = await POST(new Request("http://localhost/api/declaracion-anual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        companyId: "company-1",
        ejercicio: 2025,
        result: {},
        status: "CALCULATED",
      }),
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "NOT_SUPPORTED",
      calculation: "ANNUAL",
      reason: "ASSISTED_ONLY",
      regimen: { code: "608", trackId: "608" },
    });
  });
});
