import { describe, expect, it } from "vitest";
import {
  REGIMEN_CAPABILITIES,
  REGIMEN_CODES,
  REGIMEN_TRACK_IDS,
  RegimenCalculationNotSupportedError,
  assertAnnualCalculationSupported,
  assertAnnualCompanyCalculationSupported,
  assertMonthlyCalculationSupported,
  assertMonthlyCompanyCalculationSupported,
  companyRegimenCodes,
  companyRegimenCodesForPeriod,
  resolveRegimenTrack,
  tipoPersonaFromRfc,
} from "./regimen-capabilities";

describe("regimen capability registry", () => {
  it("contains the 19 current codes and exactly 20 PF/PM calculation tracks", () => {
    expect(REGIMEN_CODES).toHaveLength(19);
    expect(new Set(REGIMEN_CODES).size).toBe(19);
    expect(REGIMEN_TRACK_IDS).toHaveLength(20);
    expect(Object.keys(REGIMEN_CAPABILITIES).sort()).toEqual([...REGIMEN_TRACK_IDS].sort());
  });

  it("splits regimen 626 by taxpayer type", () => {
    expect(resolveRegimenTrack("626", "PF")).toMatchObject({
      ok: true,
      capability: { trackId: "626-PF" },
    });
    expect(resolveRegimenTrack("626", "PM")).toMatchObject({
      ok: true,
      capability: { trackId: "626-PM" },
    });
    expect(REGIMEN_CAPABILITIES["626-PF"].capabilities.monthly).toBe("PARTIAL");
    expect(REGIMEN_CAPABILITIES["626-PM"].capabilities.monthly).toBe("NOT_SUPPORTED");
  });

  it("enables only the five implemented monthly engines", () => {
    const enabled = [
      ["601", "PM", "601"],
      ["606", "PF", "606"],
      ["612", "PF", "612"],
      ["625", "PF", "625"],
      ["626", "PF", "626-PF"],
    ] as const;
    for (const [code, tipoPersona, trackId] of enabled) {
      expect(assertMonthlyCalculationSupported(code, tipoPersona).trackId).toBe(trackId);
    }
  });

  it.each([
    ["603", "PM"], ["605", "PF"], ["607", "PF"], ["608", "PF"],
    ["610", "PF"], ["610", "PM"], ["611", "PF"], ["614", "PF"],
    ["615", "PF"], ["616", "PF"], ["620", "PM"], ["621", "PF"],
    ["622", "PF"], ["622", "PM"], ["623", "PM"], ["624", "PM"],
    ["626", "PM"],
  ] as const)("fails closed for unsupported monthly track %s %s", (code, tipoPersona) => {
    expect(() => assertMonthlyCalculationSupported(code, tipoPersona)).toThrowError(
      RegimenCalculationNotSupportedError,
    );
    try {
      assertMonthlyCalculationSupported(code, tipoPersona);
    } catch (error) {
      expect((error as RegimenCalculationNotSupportedError).toPayload().code).toBe("NOT_SUPPORTED");
    }
  });

  it("marks regimen 616 as not applicable instead of calculating zero", () => {
    try {
      assertMonthlyCalculationSupported("616", "PF");
      expect.fail("expected a fail-closed result");
    } catch (error) {
      expect((error as RegimenCalculationNotSupportedError).toPayload()).toMatchObject({
        code: "NOT_SUPPORTED",
        reason: "NOT_APPLICABLE",
        regimen: { trackId: "616", capability: "NOT_APPLICABLE" },
      });
    }
  });

  it("enables only the implemented annual engines", () => {
    expect(assertAnnualCalculationSupported("601", "PM").trackId).toBe("601");
    expect(assertAnnualCalculationSupported("612", "PF").trackId).toBe("612");
    expect(() => assertAnnualCalculationSupported("626", "PF")).toThrowError(
      RegimenCalculationNotSupportedError,
    );
  });

  it.each([
    [null, "PF", "UNKNOWN_REGIME"],
    ["999", "PM", "UNKNOWN_REGIME"],
    ["601", null, "UNKNOWN_TAXPAYER_TYPE"],
    ["601", "PF", "INCOMPATIBLE_TAXPAYER_TYPE"],
    ["612", "PM", "INCOMPATIBLE_TAXPAYER_TYPE"],
  ] as const)("returns NOT_SUPPORTED for invalid combination %s %s", (code, tipoPersona, reason) => {
    try {
      assertMonthlyCalculationSupported(code, tipoPersona);
      expect.fail("expected a fail-closed result");
    } catch (error) {
      expect((error as RegimenCalculationNotSupportedError).toPayload()).toMatchObject({
        code: "NOT_SUPPORTED",
        reason,
      });
    }
  });

  it("derives taxpayer type only from a usable RFC length", () => {
    expect(tipoPersonaFromRfc("AAA010101AAA")).toBe("PM");
    expect(tipoPersonaFromRfc("AAAA010101AAA")).toBe("PF");
    expect(tipoPersonaFromRfc("mock-rfc")).toBeNull();
    expect(tipoPersonaFromRfc(null)).toBeNull();
  });

  it("builds one canonical set from the legacy scalar and every CSF regimen", () => {
    expect(companyRegimenCodes("612, 605", ["605", "606", " 612 ", null])).toEqual([
      "612",
      "605",
      "606",
    ]);
  });

  it("uses the scalar only when no CompanyRegimen evidence exists", () => {
    expect(companyRegimenCodesForPeriod({
      regimenFiscal: "612, 605",
      regimenes: [],
      from: new Date("2025-01-01T00:00:00.000Z"),
      to: new Date("2026-01-01T00:00:00.000Z"),
    })).toEqual(["612", "605"]);
  });

  it("includes a currently active row in the current period", () => {
    expect(companyRegimenCodesForPeriod({
      regimenFiscal: "612",
      regimenes: [{
        code: "626",
        since: new Date("2026-01-01T00:00:00.000Z"),
        endedAt: null,
        active: true,
      }],
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-09-01T00:00:00.000Z"),
    })).toEqual(["626"]);
  });

  it("resolves the rows whose known lifecycle overlaps the requested period", () => {
    expect(companyRegimenCodesForPeriod({
      regimenFiscal: "626",
      regimenes: [
        {
          code: "612",
          since: new Date("2024-01-01T00:00:00.000Z"),
          endedAt: new Date("2026-09-15T00:00:00.000Z"),
          active: false,
        },
        {
          code: "626",
          since: new Date("2026-01-01T00:00:00.000Z"),
          endedAt: null,
          active: true,
        },
      ],
      from: new Date("2025-08-01T00:00:00.000Z"),
      to: new Date("2025-09-01T00:00:00.000Z"),
    })).toEqual(["612"]);
  });

  it("includes a regime ended during the period and excludes one ended at its start", () => {
    expect(companyRegimenCodesForPeriod({
      regimenFiscal: "626",
      regimenes: [
        {
          code: "606",
          since: null,
          endedAt: new Date("2025-08-15T00:00:00.000Z"),
          active: false,
        },
        {
          code: "612",
          since: null,
          endedAt: new Date("2025-08-01T00:00:00.000Z"),
          active: false,
        },
      ],
      from: new Date("2025-08-01T00:00:00.000Z"),
      to: new Date("2025-09-01T00:00:00.000Z"),
    })).toEqual(["606"]);
  });

  it("excludes a regime that starts at the period end", () => {
    expect(companyRegimenCodesForPeriod({
      regimenFiscal: "612",
      regimenes: [{
        code: "626",
        since: new Date("2025-09-01T00:00:00.000Z"),
        endedAt: null,
        active: true,
      }],
      from: new Date("2025-08-01T00:00:00.000Z"),
      to: new Date("2025-09-01T00:00:00.000Z"),
    })).toEqual([]);
  });

  it("does not inject the current scalar when relation evidence has no overlap", () => {
    const codes = companyRegimenCodesForPeriod({
      regimenFiscal: "626",
      regimenes: [{
        code: "626",
        since: new Date("2026-01-01T00:00:00.000Z"),
        endedAt: null,
        active: true,
      }],
      from: new Date("2025-01-01T00:00:00.000Z"),
      to: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(codes).toEqual([]);
    expect(() => assertAnnualCompanyCalculationSupported({
      regimenFiscal: null,
      regimenes: codes,
      tipoPersona: "PF",
    })).toThrowError(RegimenCalculationNotSupportedError);
  });

  it("includes a regime that overlaps any part of an annual interval", () => {
    expect(companyRegimenCodesForPeriod({
      regimenFiscal: "626",
      regimenes: [{
        code: "612",
        since: new Date("2025-11-01T00:00:00.000Z"),
        endedAt: new Date("2026-02-01T00:00:00.000Z"),
        active: false,
      }],
      from: new Date("2025-01-01T00:00:00.000Z"),
      to: new Date("2026-01-01T00:00:00.000Z"),
    })).toEqual(["612"]);
  });

  it("keeps a single duplicated CSF regimen on its implemented engine", () => {
    expect(assertMonthlyCompanyCalculationSupported({
      regimenFiscal: "612",
      regimenes: ["612"],
      tipoPersona: "PF",
    }).trackId).toBe("612");
  });

  it("runs the only monthly engine when every other regime is not applicable monthly", () => {
    expect(assertMonthlyCompanyCalculationSupported({
      regimenFiscal: "605",
      regimenes: ["611", "612", "614"],
      tipoPersona: "PF",
    }).trackId).toBe("612");
  });

  it.each(["608", "999", "601"])(
    "does not ignore an assisted, unknown, or incompatible monthly track (%s)",
    (otherCode) => {
      expect(() => assertMonthlyCompanyCalculationSupported({
        regimenFiscal: "612",
        regimenes: [otherCode],
        tipoPersona: "PF",
      })).toThrowError(RegimenCalculationNotSupportedError);
    },
  );

  it("keeps an all-not-applicable monthly set explicitly not applicable", () => {
    try {
      assertMonthlyCompanyCalculationSupported({
        regimenFiscal: "605",
        regimenes: ["611", "614"],
        tipoPersona: "PF",
      });
      expect.fail("expected a fail-closed result");
    } catch (error) {
      expect((error as RegimenCalculationNotSupportedError).toPayload()).toMatchObject({
        calculation: "MONTHLY",
        reason: "NOT_APPLICABLE",
        regimen: { code: "605" },
      });
    }
  });

  it("fails closed before composing two independent monthly engines", () => {
    try {
      assertMonthlyCompanyCalculationSupported({
        regimenFiscal: "612",
        regimenes: ["606", "612"],
        tipoPersona: "PF",
      });
      expect.fail("expected a fail-closed result");
    } catch (error) {
      expect(error).toBeInstanceOf(RegimenCalculationNotSupportedError);
      expect((error as RegimenCalculationNotSupportedError).toPayload()).toMatchObject({
        code: "NOT_SUPPORTED",
        title: "Separación por régimen requerida",
        calculation: "MONTHLY",
        reason: "MULTI_REGIME_COMPOSITION_REQUIRED",
        regimenes: [
          { code: "612", trackId: "612" },
          { code: "606", trackId: "606" },
        ],
      });
    }
  });

  it("fails closed before composing annual amounts from multiple regimes", () => {
    expect(() => assertAnnualCompanyCalculationSupported({
      regimenFiscal: "612",
      regimenes: ["605", "612"],
      tipoPersona: "PF",
    })).toThrowError(RegimenCalculationNotSupportedError);
  });
});
