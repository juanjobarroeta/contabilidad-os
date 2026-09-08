import { describe, expect, it, vi } from "vitest";
import {
  SAT_NATIVE_PILOT_DEFAULTS,
  runSatNativeBuzonPilot,
  satNativePilotPolicyFromEnvironment,
  type SatNativeBuzonPilotAdapter,
} from "./pilot";

const PILOT_RFC = "AAA010101AAA";
const PILOT_POLICY = { enabled: true, authorizedRfc: PILOT_RFC } as const;

function adapterCon(
  result: Awaited<ReturnType<SatNativeBuzonPilotAdapter["probeElectronicAccounting"]>>,
): SatNativeBuzonPilotAdapter {
  return { probeElectronicAccounting: vi.fn().mockResolvedValue(result) };
}

describe("controlled native SAT Buzón pilot", () => {
  it("loads the gate only from strict operator environment values", () => {
    expect(satNativePilotPolicyFromEnvironment({
      SAT_NATIVE_PILOT_ENABLED: "true",
      SAT_NATIVE_PILOT_RFC: ` ${PILOT_RFC} `,
    })).toEqual({ enabled: true, authorizedRfc: PILOT_RFC });
    expect(satNativePilotPolicyFromEnvironment({
      SAT_NATIVE_PILOT_ENABLED: "1",
      SAT_NATIVE_PILOT_RFC: PILOT_RFC,
    })).toEqual({ enabled: false, authorizedRfc: PILOT_RFC });
  });

  it("is disabled by default and never invokes an adapter", async () => {
    const adapter = adapterCon({
      kind: "COMPLETED",
      metadata: {
        fetchedAt: "2026-09-08T12:00:00.000Z",
        electronicAccountingRecordCount: 1,
        receiptArtifactCount: 1,
      },
    });

    const result = await runSatNativeBuzonPilot(
      { rfc: PILOT_RFC },
      adapter,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "NOT_CONFIGURED", retryable: false },
    });
    expect(adapter.probeElectronicAccounting).not.toHaveBeenCalled();
    expect(SAT_NATIVE_PILOT_DEFAULTS.enabled).toBe(false);
    expect(SAT_NATIVE_PILOT_DEFAULTS.authorizedRfc).toBeNull();
  });

  it("permits exactly the authorized RFC and passes only a read-only metadata request", async () => {
    const adapter = adapterCon({
      kind: "COMPLETED",
      metadata: {
        fetchedAt: "2026-09-08T12:00:00.000Z",
        electronicAccountingRecordCount: 3,
        receiptArtifactCount: 2,
      },
    });

    const result = await runSatNativeBuzonPilot(
      { rfc: ` ${PILOT_RFC.toLowerCase()} ` },
      adapter,
      PILOT_POLICY,
    );

    expect(adapter.probeElectronicAccounting).toHaveBeenCalledWith({
      rfc: PILOT_RFC,
      operation: "LIST_ELECTRONIC_ACCOUNTING",
      surface: "BUZON_TRIBUTARIO_CE",
      mode: "METADATA_ONLY",
      readOnly: true,
    });
    expect(result).toEqual({
      ok: true,
      operation: "LIST_ELECTRONIC_ACCOUNTING",
      value: {
        surface: "BUZON_TRIBUTARIO_CE",
        mode: "METADATA_ONLY",
        fetchedAt: "2026-09-08T12:00:00.000Z",
        electronicAccountingRecordCount: 3,
        receiptArtifactCount: 2,
        originalSubmittedXml: "UNVERIFIED",
      },
    });
    expect(JSON.stringify(result)).not.toContain(PILOT_RFC);
  });

  it("rejects every other RFC before an adapter can run", async () => {
    const adapter = adapterCon({ kind: "INTERACTIVE_CHALLENGE" });

    const result = await runSatNativeBuzonPilot(
      { rfc: "BBB010101BBB" },
      adapter,
      PILOT_POLICY,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ACCESS_DENIED", retryable: false },
    });
    expect(adapter.probeElectronicAccounting).not.toHaveBeenCalled();
  });

  it("stops an interactive challenge as NEEDS_USER_ACTION", async () => {
    const result = await runSatNativeBuzonPilot(
      { rfc: PILOT_RFC },
      adapterCon({ kind: "INTERACTIVE_CHALLENGE" }),
      PILOT_POLICY,
    );

    expect(result).toMatchObject({
      ok: false,
      operation: "LIST_ELECTRONIC_ACCOUNTING",
      error: { code: "NEEDS_USER_ACTION", recovery: "USER", retryable: false },
    });
  });

  it("redacts adapter exceptions and rejects malformed metadata", async () => {
    const throwing: SatNativeBuzonPilotAdapter = {
      probeElectronicAccounting: vi.fn().mockRejectedValue(new Error("cookie=secret")),
    };
    const thrown = await runSatNativeBuzonPilot(
      { rfc: PILOT_RFC },
      throwing,
      PILOT_POLICY,
    );
    const malformed = await runSatNativeBuzonPilot(
      { rfc: PILOT_RFC },
      adapterCon({
        kind: "COMPLETED",
        metadata: {
          fetchedAt: "not-a-date",
          electronicAccountingRecordCount: -1,
          receiptArtifactCount: 0,
        },
      }),
      PILOT_POLICY,
    );

    expect(thrown).toMatchObject({ ok: false, error: { code: "UNEXPECTED" } });
    expect(JSON.stringify(thrown)).not.toContain("secret");
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_INVALID", retryable: false },
    });
  });
});
