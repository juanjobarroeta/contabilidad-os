import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  company: vi.fn(), invoice: vi.fn(), declaration: vi.fn(), payroll: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "qa-user" } }) }));
vi.mock("@/lib/authz", () => ({ getEffectiveCompanyMembership: vi.fn().mockResolvedValue({ role: "OWNER" }) }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  company: { findUnique: db.company },
  invoice: { findMany: db.invoice, aggregate: db.invoice, groupBy: db.invoice },
  taxDeclaration: { findFirst: db.declaration, upsert: db.declaration },
  payrollItem: { aggregate: db.payroll },
} }));

// No mock of the tax engine, regime resolver, capability guard, or API adapter.
import { GET as monthly } from "@/app/api/impuestos/route";
import { GET as annual, POST as saveAnnual } from "@/app/api/declaracion-anual/route";
import { regimeCases } from "./fixtures/v1";
import { periodNumbers, regimeRows, syntheticCompanyId } from "./scenario";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("QA fixtures must not call the network"));
  for (const mock of [db.invoice, db.declaration, db.payroll]) {
    mock.mockRejectedValue(new Error("Rejected regimes must not reach fiscal data"));
  }
});

afterEach(() => {
  expect(db.invoice).not.toHaveBeenCalled();
  expect(db.declaration).not.toHaveBeenCalled();
  expect(db.payroll).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("QA-001 v1: unsupported calculations fail before fiscal reads or writes", () => {
  it.each(regimeCases.filter((fixture) => fixture.expected.reason !== null))("$id — $description", async (fixture) => {
    const { year, month } = periodNumbers(fixture.period);
    db.company.mockResolvedValue({
      rfc: fixture.rfc, razonSocial: "QA synthetic company", regimenFiscal: fixture.scalar,
      regimenes: regimeRows(fixture), coeficienteUtilidad: null, coeficienteAnio: null,
      perdidaFiscalPendiente: null, perdidaFiscalAnio: null, plataformaActividad: null,
    });
    const responses = fixture.calculation === "MONTHLY"
      ? [await monthly(new Request(`https://qa.invalid/api/impuestos?companyId=${syntheticCompanyId}&year=${year}&month=${month}`))]
      : [
        await annual(new Request(`https://qa.invalid/api/declaracion-anual?companyId=${syntheticCompanyId}&ejercicio=${year}`)),
        await saveAnnual(new Request("https://qa.invalid/api/declaracion-anual", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ companyId: syntheticCompanyId, ejercicio: year, result: {}, status: "CALCULATED" }),
        })),
      ];
    for (const response of responses) {
      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body).toMatchObject({
        code: "NOT_SUPPORTED", calculation: fixture.calculation, reason: fixture.expected.reason,
        regimen: { trackId: fixture.expected.track },
      });
      // No successful-looking zero or numeric tax result on the rejection path.
      expect(body).not.toHaveProperty("iva");
      expect(body).not.toHaveProperty("isr");
      expect(body).not.toHaveProperty("result");
      if (fixture.expected.reason === "MULTI_REGIME_COMPOSITION_REQUIRED") {
        expect(body.regimenes.map((regimen: { code: string }) => regimen.code)).toEqual(fixture.expected.codes);
      }
    }
    expect(db.company).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: syntheticCompanyId },
      select: expect.objectContaining({
        regimenes: { select: { code: true, since: true, endedAt: true, active: true } },
      }),
    }));
  });
});
