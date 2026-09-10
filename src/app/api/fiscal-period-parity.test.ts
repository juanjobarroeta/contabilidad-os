import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { computeTaxPosition, checklistDeclaracion } = vi.hoisted(() => ({
  computeTaxPosition: vi.fn(),
  checklistDeclaracion: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  withAuthz: (handler: (req: Request) => Promise<Response>) => handler,
  requireMembership: vi.fn().mockResolvedValue({ role: "OWNER" }),
  requireModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/impuestos", () => ({ computeTaxPosition }));
vi.mock("@/lib/fiscal/checklist-declaracion", () => ({ checklistDeclaracion }));
vi.mock("@/lib/fiscal/retenciones", () => ({
  retencionesDelPeriodo: vi.fn().mockResolvedValue({ aEnterar: 0 }),
}));
vi.mock("@/lib/automotriz/isan-periodo", () => ({
  isanDelPeriodo: vi.fn().mockResolvedValue({ total: 0, advertencias: [] }),
}));
vi.mock("@/lib/hospital/isr-medicos", () => ({
  isrRetenidoMedicosDelPeriodo: vi.fn().mockResolvedValue({ monto: 0, comprobantes: 0 }),
}));
vi.mock("@/lib/fiscal/ieps/leer", () => ({
  leerRenglonesIeps: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { company: { findUnique: vi.fn().mockResolvedValue(null) } },
}));

import { GET as getAutomotriz } from "./automotriz/fiscal/route";
import { GET as getHospital } from "./hospital/fiscal/route";
import { GET as getSalameria } from "./salameria/fiscal/route";

const routes = [
  ["automotriz", getAutomotriz],
  ["hospital", getHospital],
  ["salameria", getSalameria],
] as const;

describe("satellite fiscal API period parity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Railway already sees September; Mexico City is still August 31.
    vi.setSystemTime(new Date("2026-09-01T00:30:00.000Z"));
    computeTaxPosition.mockResolvedValue({
      periodo: "2026-07",
      iva: { pagar: 0 },
      isr: { isrPagar: 0 },
      advertencias: [],
      efos: null,
    });
    checklistDeclaracion.mockResolvedValue({
      fechaLimite: "2026-08-17",
      diasRestantes: -14,
      vencida: true,
      items: [],
      resumen: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  for (const [name, handler] of routes) {
    it(`${name} defaults to the shared completed month`, async () => {
      const response = await handler(new Request(`https://app.test/api/${name}/fiscal?companyId=co_1`));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect({ year: body.year, month: body.month, periodo: body.periodo }).toEqual({
        year: 2026,
        month: 7,
        periodo: "2026-07",
      });
      expect(computeTaxPosition).toHaveBeenCalledWith("co_1", 2026, 7);
      expect(checklistDeclaracion).toHaveBeenCalledWith("co_1", 2026, 7, expect.any(Date));
    });
  }
});
