import { describe, it, expect, beforeEach, vi } from "vitest";

// La inversión codAgrup → cuenta propia: única resuelve, ambigua NO (espera
// override del contador o la resolución por módulo de la Fase 2), y un código
// sin candidatas cae al fallback agrupador de siempre.

type Cuenta = { id: string; companyId: string; cuentaSAT: string; subcuenta: string | null; nombre: string; codAgrup: string | null; isActive: boolean };
const state = vi.hoisted(() => ({ cuentas: [] as Cuenta[], overrides: [] as { companyId: string; codigoMotor: string; chartAccountId: string }[] }));

vi.mock("../prisma", () => ({
  prisma: {
    chartAccount: {
      findMany: async ({ where, take }: any) => {
        const hits = state.cuentas.filter(
          (c) => c.companyId === where.companyId && c.isActive === where.isActive && c.codAgrup === where.codAgrup,
        );
        return (take ? hits.slice(0, take) : hits).map((c) => ({ ...c }));
      },
    },
    postingCuentaOverride: {
      findUnique: async ({ where }: any) => {
        const o = state.overrides.find(
          (x) => x.companyId === where.companyId_codigoMotor.companyId && x.codigoMotor === where.companyId_codigoMotor.codigoMotor,
        );
        if (!o) return null;
        return { ...o, cuenta: state.cuentas.find((c) => c.id === o.chartAccountId)! };
      },
    },
  },
}));

import { resolverCuentaPropia, coberturaPlanPropio } from "./resolver-plan-propio";

const cta = (id: string, codAgrup: string | null, over: Partial<Cuenta> = {}): Cuenta => ({
  id, companyId: "c1", cuentaSAT: `1301-00${id}-0000`, subcuenta: null,
  nombre: `CUENTA ${id}`, codAgrup, isActive: true, ...over,
});

beforeEach(() => { state.cuentas = []; state.overrides = []; });

describe("resolverCuentaPropia()", () => {
  it("una sola candidata resuelve a la cuenta propia", async () => {
    state.cuentas = [cta("01", "102.01")];
    expect((await resolverCuentaPropia("c1", "102.01"))?.id).toBe("01");
  });

  it("ambigua devuelve null: la decisión es del contador, no una adivinanza", async () => {
    state.cuentas = [cta("01", "115.04"), cta("02", "115.04")];
    expect(await resolverCuentaPropia("c1", "115.04")).toBeNull();
  });

  it("el override del contador gana sobre la inversión", async () => {
    state.cuentas = [cta("01", "601.48"), cta("02", "601.48")];
    state.overrides = [{ companyId: "c1", codigoMotor: "601.48", chartAccountId: "02" }];
    expect((await resolverCuentaPropia("c1", "601.48"))?.id).toBe("02");
  });

  it("sin candidatas devuelve null (fallback agrupador de siempre)", async () => {
    expect(await resolverCuentaPropia("c1", "999.99")).toBeNull();
  });

  it("un override a cuenta inactiva no resuelve (no re-postear a una muerta)", async () => {
    state.cuentas = [cta("01", "601.48", { isActive: false })];
    state.overrides = [{ companyId: "c1", codigoMotor: "601.48", chartAccountId: "01" }];
    expect(await resolverCuentaPropia("c1", "601.48")).toBeNull();
  });
});

describe("coberturaPlanPropio()", () => {
  it("clasifica cada código del motor: única / ambigua / sin candidata / override", async () => {
    state.cuentas = [cta("01", "102.01"), cta("02", "115.04"), cta("03", "115.04"), cta("04", "601.48")];
    state.overrides = [{ companyId: "c1", codigoMotor: "601.48", chartAccountId: "04" }];
    const cob = await coberturaPlanPropio("c1", ["102.01", "115.04", "601.48", "999.99"]);
    expect(cob.map((c) => `${c.codigoMotor}:${c.estado}`)).toEqual([
      "102.01:unica", "115.04:ambigua", "601.48:override", "999.99:sin_candidata",
    ]);
  });
});
