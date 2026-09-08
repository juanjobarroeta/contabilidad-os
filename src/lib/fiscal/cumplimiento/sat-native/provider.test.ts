import { describe, expect, it } from "vitest";
import {
  SAT_READ_ERROR_CODES,
  SAT_READ_ERROR_POLICY,
  SatReadError,
  satReadSuccess,
  toSatReadFailure,
} from "./errors";
import {
  SatReadOnlyProviderUnavailable,
  type SatReadOnlyProvider,
} from "./provider";
import { SAT_READ_ONLY_CAPABILITIES } from "./types";

describe("native SAT read-only boundary", () => {
  it("advertises only list and download capabilities", () => {
    expect(SAT_READ_ONLY_CAPABILITIES).toEqual({
      declarations: { list: true, downloadArtifacts: true },
      electronicAccounting: {
        list: true,
        downloadArtifacts: true,
        originalSubmittedXml: "UNVERIFIED",
      },
      mutations: false,
    });
    expect(Object.isFrozen(SAT_READ_ONLY_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(SAT_READ_ONLY_CAPABILITIES.declarations)).toBe(true);
    expect(
      Object.isFrozen(SAT_READ_ONLY_CAPABILITIES.electronicAccounting),
    ).toBe(true);
  });

  it("defines a recovery policy for every stable error code", () => {
    expect(Object.keys(SAT_READ_ERROR_POLICY).sort()).toEqual(
      [...SAT_READ_ERROR_CODES].sort(),
    );
    expect(SAT_READ_ERROR_POLICY.PORTAL_UNAVAILABLE).toMatchObject({
      recovery: "RETRY",
      retryable: true,
    });
    expect(SAT_READ_ERROR_POLICY.AUTH_REJECTED).toMatchObject({
      recovery: "USER",
      retryable: false,
    });
    expect(SAT_READ_ERROR_POLICY.PORTAL_CONTRACT_CHANGED).toMatchObject({
      recovery: "OPERATOR",
      retryable: false,
    });
  });

  it("redacts unexpected upstream error details and fails closed", () => {
    const failure = toSatReadFailure(
      new Error("password=do-not-leak; upstream html"),
      "LIST_DECLARATIONS",
    );

    expect(failure).toEqual({
      ok: false,
      operation: "LIST_DECLARATIONS",
      error: {
        code: "UNEXPECTED",
        message: SAT_READ_ERROR_POLICY.UNEXPECTED.message,
        recovery: "OPERATOR",
        retryable: false,
      },
    });
    expect(JSON.stringify(failure)).not.toContain("do-not-leak");
    expect(JSON.stringify(failure)).not.toContain("upstream html");
  });

  it("preserves a classified domain error without exposing a cause", () => {
    const error = new SatReadError("RATE_LIMITED", "LIST_DECLARATIONS");
    const failure = toSatReadFailure(error, "LIST_DECLARATIONS");

    expect(failure.operation).toBe("LIST_DECLARATIONS");
    expect(failure.error).toMatchObject({
      code: "RATE_LIMITED",
      recovery: "RETRY",
      retryable: true,
    });
    expect(Object.keys(failure.error).sort()).toEqual(
      ["code", "message", "recovery", "retryable"].sort(),
    );
  });

  it("stops interactive SAT challenges for authorized user action", () => {
    const failure = toSatReadFailure(
      new SatReadError("NEEDS_USER_ACTION", "LIST_ELECTRONIC_ACCOUNTING"),
      "LIST_ELECTRONIC_ACCOUNTING",
    );

    expect(failure).toEqual({
      ok: false,
      operation: "LIST_ELECTRONIC_ACCOUNTING",
      error: {
        code: "NEEDS_USER_ACTION",
        message: SAT_READ_ERROR_POLICY.NEEDS_USER_ACTION.message,
        recovery: "USER",
        retryable: false,
      },
    });
  });

  it("creates a discriminated success result", () => {
    expect(satReadSuccess("LIST_DECLARATIONS", { count: 2 })).toEqual({
      ok: true,
      operation: "LIST_DECLARATIONS",
      value: { count: 2 },
    });
  });

  it("uses a no-I/O provider that returns not-configured for every operation", async () => {
    const provider: SatReadOnlyProvider = new SatReadOnlyProviderUnavailable();
    const expected = [
      provider.listDeclarations("company-id", {
        fromFiscalYear: 2025,
        toFiscalYear: 2026,
      }),
      provider.downloadDeclarationArtifact("company-id", {
        source: "DECLARATIONS",
        remoteId: "declaration-1",
        kind: "ACK_RECEIPT",
      }),
      provider.listElectronicAccounting("company-id", {
        from: { fiscalYear: 2025, periodCode: "01" },
        to: { fiscalYear: 2026, periodCode: "13" },
      }),
      provider.downloadElectronicAccountingArtifact("company-id", {
        source: "ELECTRONIC_ACCOUNTING",
        remoteId: "ce-1",
        kind: "RECEIPT",
      }),
    ];

    const outcomes = await Promise.all(expected);
    const operations = outcomes.map((outcome) => {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return null;
      expect(outcome.error).toMatchObject({
        code: "NOT_CONFIGURED",
        retryable: false,
      });
      return outcome.operation;
    });

    expect(operations).toEqual([
      "LIST_DECLARATIONS",
      "DOWNLOAD_DECLARATION_ARTIFACT",
      "LIST_ELECTRONIC_ACCOUNTING",
      "DOWNLOAD_ELECTRONIC_ACCOUNTING_ARTIFACT",
    ]);
  });
});
