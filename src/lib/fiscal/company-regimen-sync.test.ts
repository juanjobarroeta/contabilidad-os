import { describe, expect, it } from "vitest";
import {
  CompanyRegimenSyncError,
  parseCsfRegimenDate,
  planCompanyRegimenSync,
  type ExistingCompanyRegimen,
} from "./company-regimen-sync";

const existing = (
  code: string,
  options: Partial<ExistingCompanyRegimen> = {},
): ExistingCompanyRegimen => ({
  code,
  label: code,
  since: null,
  isPrimary: false,
  active: true,
  ...options,
});

describe("company regime CSF sync plan", () => {
  it("preserves a still-current primary, activates new rows, and ends missing rows", () => {
    const oldSince = new Date("2020-01-01T00:00:00.000Z");
    const plan = planCompanyRegimenSync({
      companyPrimary: "612",
      parsedRegimenes: [
        { code: "605", label: "Sueldos", since: "03/04/2021" },
        { code: "612", label: "", since: null },
      ],
      existingRegimenes: [
        existing("612", { isPrimary: true, since: oldSince }),
        existing("606"),
      ],
    });

    expect(plan.primaryCode).toBe("612");
    expect(plan.currentCodes).toEqual(["605", "612"]);
    expect(plan.activatedCodes).toEqual(["605"]);
    expect(plan.deactivatedCodes).toEqual(["606"]);
    expect(plan.upserts).toEqual([
      expect.objectContaining({ code: "605", label: "Sueldos", isPrimary: false }),
      expect.objectContaining({ code: "612", since: oldSince, isPrimary: true }),
    ]);
  });

  it("reactivates a historical regime and accepts an explicit new primary", () => {
    const plan = planCompanyRegimenSync({
      companyPrimary: "606",
      parsedPrimary: "612",
      parsedRegimenes: [{ code: "606" }, { code: "612" }],
      existingRegimenes: [
        existing("606", { isPrimary: true }),
        existing("612", { active: false }),
      ],
    });

    expect(plan.primaryCode).toBe("612");
    expect(plan.activatedCodes).toEqual(["612"]);
    expect(plan.upserts.find((regimen) => regimen.code === "612")).toMatchObject({
      label: "Personas Físicas con Actividades Empresariales y Profesionales",
      isPrimary: true,
    });
  });

  it("requires a primary when several regimes replace the previous set", () => {
    expect(() => planCompanyRegimenSync({
      companyPrimary: "626",
      parsedRegimenes: [{ code: "605" }, { code: "612" }],
      existingRegimenes: [existing("626", { isPrimary: true })],
    })).toThrowError(CompanyRegimenSyncError);
    try {
      planCompanyRegimenSync({
        companyPrimary: "626",
        parsedRegimenes: [{ code: "605" }, { code: "612" }],
        existingRegimenes: [],
      });
    } catch (error) {
      expect((error as CompanyRegimenSyncError).code).toBe("PRIMARY_REQUIRED");
    }
  });

  it.each([
    [[], "NO_REGIMES"],
    [[{ code: "999" }], "UNKNOWN_REGIME"],
  ] as const)("rejects an unsafe parsed set", (parsedRegimenes, code) => {
    try {
      planCompanyRegimenSync({
        companyPrimary: "612",
        parsedRegimenes,
        existingRegimenes: [],
      });
      expect.fail("expected a fail-closed plan");
    } catch (error) {
      expect((error as CompanyRegimenSyncError).code).toBe(code);
    }
  });

  it("rejects a declared primary that is absent from the CSF set", () => {
    try {
      planCompanyRegimenSync({
        companyPrimary: "612",
        parsedPrimary: "606",
        parsedRegimenes: [{ code: "612" }],
        existingRegimenes: [],
      });
      expect.fail("expected a fail-closed plan");
    } catch (error) {
      expect((error as CompanyRegimenSyncError).code).toBe("PRIMARY_NOT_IN_CSF");
    }
  });

  it("parses a real CSF date in UTC and rejects impossible dates", () => {
    expect(parseCsfRegimenDate("03/04/2021")?.toISOString()).toBe("2021-04-03T00:00:00.000Z");
    expect(parseCsfRegimenDate("31/02/2021")).toBeNull();
    expect(parseCsfRegimenDate("2021-04-03")).toBeNull();
  });
});
