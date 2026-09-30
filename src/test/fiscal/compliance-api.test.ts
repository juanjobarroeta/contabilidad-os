import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  company: vi.fn(), obligations: vi.fn(), declarations: vi.fn(), seed: vi.fn(),
  obligationCreate: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "qa-user" } }) }));
vi.mock("@/lib/authz", () => ({ getEffectiveCompanyMembership: vi.fn().mockResolvedValue({ role: "OWNER" }) }));
vi.mock("@/lib/obligaciones-seed", () => ({ seedCompanyObligaciones: db.seed }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  company: { findUnique: db.company },
  companyObligation: {
    findMany: db.obligations, findUnique: vi.fn().mockResolvedValue(null), create: db.obligationCreate,
  },
  taxDeclaration: { findMany: db.declarations },
  payrollItem: { findFirst: vi.fn().mockResolvedValue(null) },
} }));

import { GET } from "@/app/api/obligaciones/route";
import { closeCases, periodCases } from "./fixtures/v1";
import { periodNumbers, syntheticCompanyId } from "./scenario";

interface CalendarPeriod {
  periodo: string;
  vencimiento: string;
  estado: string;
  declaracionStatus: string | null;
}
interface Calendar {
  year: number;
  obligaciones: { tipo: string; periodos: CalendarPeriod[] }[];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("QA fixtures must not call the network"));
  db.seed.mockResolvedValue(undefined);
  db.obligationCreate.mockRejectedValue(new Error("Unexpected obligation write"));
  db.obligations.mockResolvedValue([{
    tipo: "IVA_MENSUAL", descripcion: "Synthetic monthly IVA", periodicidad: "MENSUAL",
    diaVencimiento: 17, mesVencimiento: null, fuente: "MANUAL",
  }]);
});

afterEach(() => {
  expect(db.obligationCreate).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function calendarPeriod(period: string) {
  const { year } = periodNumbers(period);
  const response = await GET(new Request(`https://qa.invalid/api/obligaciones?companyId=${syntheticCompanyId}&year=${year}`));
  expect(response.status).toBe(200);
  const body: Calendar = await response.json();
  expect(body.year).toBe(year);
  expect(db.declarations).toHaveBeenCalledWith(expect.objectContaining({
    where: { companyId: syntheticCompanyId, periodo: { startsWith: String(year) } },
  }));
  expect(db.seed).toHaveBeenCalledWith(syntheticCompanyId, ["601"]);
  const result = body.obligaciones.find((ob) => ob.tipo === "IVA_MENSUAL")?.periodos.find((p) => p.periodo === period);
  expect(result).toBeDefined();
  return result!;
}

function company(onboarded: string) {
  // Extra returned fields do not supply any calendar/filing decisions.
  db.company.mockResolvedValue({
    regimenFiscal: "601", regimenes: [{ code: "601" }], createdAt: new Date(onboarded),
  });
}

describe("QA-001 v1: actual Compliance API with synthetic database rows", () => {
  it.each(periodCases)("$id — calendar date and midnight status", async (fixture) => {
    vi.setSystemTime(new Date(fixture.now));
    company("2020-01-01T12:00:00Z");
    db.declarations.mockResolvedValue([]);
    const period = await calendarPeriod(fixture.expected.period);
    expect(period).toMatchObject({
      vencimiento: fixture.expected.due,
      estado: fixture.expected.days < 0 ? "OVERDUE" : "UPCOMING",
      declaracionStatus: null,
    });
    expect(period.vencimiento).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each(closeCases)("$id — declaration evidence agrees with Close, not ledger availability", async ({ input, expected }) => {
    vi.setSystemTime(new Date(input.now));
    company(input.onboarded);
    db.declarations.mockResolvedValue(input.declaration === null ? [] : [{
      tipo: "IVA_MENSUAL", periodo: input.period, status: input.declaration,
      isHistorical: input.historical, isrPagar: null,
    }]);
    expect(await calendarPeriod(input.period)).toMatchObject({
      periodo: input.period, vencimiento: "2026-08-17", estado: expected.compliance,
      declaracionStatus: input.declaration,
    });
  });
});
