import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ position: vi.fn(), checklist: vi.fn() }));
vi.mock("@/lib/authz", () => ({
  withAuthz: (handler: (req: Request) => Promise<Response>) => handler,
  requireMembership: vi.fn().mockResolvedValue({ role: "OWNER" }),
  requireModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/impuestos", () => ({ computeTaxPosition: io.position }));
vi.mock("@/lib/fiscal/checklist-declaracion", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/fiscal/checklist-declaracion")>(),
  checklistDeclaracion: io.checklist,
}));
vi.mock("@/lib/fiscal/retenciones", () => ({
  retencionesDelPeriodo: vi.fn().mockResolvedValue({ aEnterar: 0 }),
}));
vi.mock("@/lib/automotriz/isan-periodo", () => ({
  isanDelPeriodo: vi.fn().mockResolvedValue({ total: 0, advertencias: [] }),
}));
vi.mock("@/lib/hospital/isr-medicos", () => ({
  isrRetenidoMedicosDelPeriodo: vi.fn().mockResolvedValue({ monto: 0, comprobantes: 0 }),
}));
vi.mock("@/lib/fiscal/ieps/leer", () => ({ leerRenglonesIeps: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/prisma", () => ({ prisma: { company: { findUnique: vi.fn().mockResolvedValue(null) } } }));

import { GET as automotriz } from "@/app/api/automotriz/fiscal/route";
import { GET as hospital } from "@/app/api/hospital/fiscal/route";
import { GET as salameria } from "@/app/api/salameria/fiscal/route";
import { closeCases, periodCases } from "./fixtures/v1";
import { fiscalScenario, periodNumbers, syntheticCompanyId } from "./scenario";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("QA fixtures must not call the network"));
  // Derive IO results from requested arguments, never from fixture expectations.
  // Only routing/date contracts are tested here, not these synthetic amounts.
  io.position.mockImplementation(async (_id: string, year: number, month: number) => ({
    periodo: `${year}-${String(month).padStart(2, "0")}`,
    iva: { pagar: 7 }, isr: { isrPagar: 11 }, advertencias: [], efos: null,
  }));
  io.checklist.mockImplementation(async (_id: string, year: number, month: number, hoy: Date) => (
    fiscalScenario({
      ...closeCases[2].input, now: hoy.toISOString(), period: `${year}-${String(month).padStart(2, "0")}`,
    }).checklist
  ));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each([
  ["automotriz", automotriz], ["hospital", hospital], ["salameria", salameria],
] as const)("QA-001 v1: %s fiscal API", (name, handler) => {
  it.each(periodCases)("$id — default period and returned deadline", async (fixture) => {
    vi.setSystemTime(new Date(fixture.now));
    const response = await handler(new Request(`https://qa.invalid/api/${name}/fiscal?companyId=${syntheticCompanyId}`));
    expect(response.status).toBe(200);
    const { year, month } = periodNumbers(fixture.expected.period);
    expect(await response.json()).toMatchObject({
      year, month, periodo: fixture.expected.period,
      fechaLimite: fixture.expected.due, diasRestantes: fixture.expected.days, vencida: fixture.expected.days < 0,
    });
    expect(io.position).toHaveBeenCalledExactlyOnceWith(syntheticCompanyId, year, month);
    expect(io.checklist).toHaveBeenCalledExactlyOnceWith(syntheticCompanyId, year, month, new Date(fixture.now));
  });

  it("an explicit historical period overrides the default", async () => {
    vi.setSystemTime(new Date("2026-09-29T18:00:00Z"));
    const response = await handler(new Request(`https://qa.invalid/api/${name}/fiscal?companyId=${syntheticCompanyId}&year=2025&month=12`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ year: 2025, month: 12, periodo: "2025-12", fechaLimite: "2026-01-19" });
    expect(io.position).toHaveBeenCalledExactlyOnceWith(syntheticCompanyId, 2025, 12);
  });
});
