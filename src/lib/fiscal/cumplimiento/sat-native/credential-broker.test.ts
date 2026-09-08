import { describe, expect, it, vi } from "vitest";
import {
  SAT_NATIVE_PILOT_ACKNOWLEDGEMENT,
  SAT_NATIVE_PILOT_EXECUTION_SCOPE,
  SAT_NATIVE_PILOT_PURPOSE,
  portalSerialFromCertificateHex,
  satNativeCredentialPolicyFromEnvironment,
  withSatNativePilotSignerForTest as withSatNativePilotSigner,
  type PreparedSatNativeCredential,
  type SatNativeCredentialStore,
  type SatNativePilotSigner,
} from "./credential-broker";

const RFC = "AAA010101AAA";
const RUN_ID = "b4a2c9ee-55b7-4ad5-a567-9ad5fb77f431";
const LOGIN_ACTION =
  "https://login.siat.sat.gob.mx/nidp/idff/sso" +
  "?id=fiel_Aviso&sid=0&option=credential&sid=0";
const TOKEN_UUID = Buffer.from(
  "007d4ca0-465c-40e3-951b-c27bb5b1c343",
  "utf8",
).toString("base64");
const PORTAL_SERIAL = "30001000000400000123";

const ENV = Object.freeze({
  SAT_NATIVE_PILOT_ENABLED: "true",
  SAT_NATIVE_PILOT_RFC: RFC,
  SAT_NATIVE_PILOT_OPERATOR_USER_ID: "operator-1",
  SAT_NATIVE_PILOT_RUN_ID: RUN_ID,
  SAT_NATIVE_PILOT_ACKNOWLEDGEMENT,
  SAT_NATIVE_PILOT_EXECUTION_SCOPE,
});

const PREPARED: PreparedSatNativeCredential = Object.freeze({
  companyId: "company-1",
  rfc: RFC,
  actorEmail: "operator@example.test",
  encryptedCertificate: "enc:v1:certificate",
  encryptedPrivateKey: "enc:v1:private-key",
  encryptedPassword: "enc:v1:password",
});

function storeWith(
  prepared: PreparedSatNativeCredential = PREPARED,
  events?: string[],
): SatNativeCredentialStore {
  return {
    prepare: vi.fn(async (input) => {
      events?.push("prepare-and-start-audit");
      expect(input).toMatchObject({
        authorizedRfc: RFC,
        operatorUserId: "operator-1",
        runId: RUN_ID,
        purpose: SAT_NATIVE_PILOT_PURPOSE,
      });
      return prepared;
    }),
    finish: vi.fn(async (input) => {
      events?.push("finish-and-terminal-audit");
      expect(input).toMatchObject({
        companyId: "company-1",
        operatorUserId: "operator-1",
        runId: RUN_ID,
        purpose: SAT_NATIVE_PILOT_PURPOSE,
      });
    }),
  };
}

function decryptFixture(stored: string): string {
  const fixtures: Record<string, string> = {
    "enc:v1:certificate": Buffer.from("certificate").toString("base64"),
    "enc:v1:private-key": Buffer.from("private-key").toString("base64"),
    "enc:v1:password": "correct horse battery staple",
  };
  return fixtures[stored] ?? "";
}

function validCredential(events?: string[]) {
  return {
    isFiel: vi.fn(() => true),
    rfc: vi.fn(() => RFC),
    certificate: vi.fn(() => ({
      validOn: vi.fn(() => true),
      validTo: vi.fn(() => new Date("2029-08-28T00:41:13.000Z")),
      serialNumber: vi.fn(() => ({
        hexadecimal: vi.fn(() =>
          Buffer.from(PORTAL_SERIAL, "ascii").toString("hex")),
      })),
    })),
    sign: vi.fn((_token: string, algorithm: "sha1") => {
      events?.push(`sign-${algorithm}`);
      return "\x01\x02\x03";
    }),
  };
}

describe("SAT native credential broker", () => {
  it("loads every authorization gate strictly from worker environment", () => {
    expect(satNativeCredentialPolicyFromEnvironment({
      ...ENV,
      SAT_NATIVE_PILOT_RFC: ` ${RFC.toLowerCase()} `,
      SAT_NATIVE_PILOT_RUN_ID: RUN_ID.toUpperCase(),
    })).toEqual({
      enabled: true,
      authorizedRfc: RFC,
      operatorUserId: "operator-1",
      runId: RUN_ID,
      acknowledgement: SAT_NATIVE_PILOT_ACKNOWLEDGEMENT,
      executionScope: SAT_NATIVE_PILOT_EXECUTION_SCOPE,
    });
    expect(satNativeCredentialPolicyFromEnvironment({
      ...ENV,
      SAT_NATIVE_PILOT_ENABLED: "1",
    }).enabled).toBe(false);
  });

  it.each([
    { SAT_NATIVE_PILOT_ENABLED: "false" },
    { SAT_NATIVE_PILOT_RFC: "" },
    { SAT_NATIVE_PILOT_OPERATOR_USER_ID: "" },
    { SAT_NATIVE_PILOT_RUN_ID: "not-a-uuid" },
    { SAT_NATIVE_PILOT_ACKNOWLEDGEMENT: "yes" },
    { SAT_NATIVE_PILOT_EXECUTION_SCOPE: "FOLLOW_REDIRECTS" },
  ])("rejects an incomplete policy before database or credential access: %o", async (override) => {
    const store = storeWith();
    const decrypt = vi.fn(decryptFixture);

    await expect(withSatNativePilotSigner(async () => undefined, {
      env: { ...ENV, ...override },
      store,
      decrypt,
      createCredential: () => validCredential(),
    })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });

    expect(store.prepare).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("audits before decrypting and exposes only a one-use challenge signer", async () => {
    const events: string[] = [];
    const store = storeWith(PREPARED, events);
    const decrypt = vi.fn((stored: string) => {
      events.push("decrypt");
      return decryptFixture(stored);
    });
    const credential = validCredential(events);
    let escapedSigner: SatNativePilotSigner | null = null;

    const result = await withSatNativePilotSigner(async (signer) => {
      events.push("callback");
      escapedSigner = signer;
      const loginToken = signer.buildValidatedLoginToken({
        tokenUuid: TOKEN_UUID,
        actionUrl: LOGIN_ACTION,
      });
      expect(loginToken).toEqual({
        token: expect.any(String),
        fert: "290828004113Z",
      });
      const innerToken = Buffer.from(loginToken.token, "base64").toString("utf8");
      const [challengeBase64, wrappedSignatureBase64] = innerToken.split("#");
      expect(Buffer.from(challengeBase64, "base64").toString("utf8")).toBe(
        `${TOKEN_UUID}|${RFC}|${PORTAL_SERIAL}`,
      );
      expect(Buffer.from(wrappedSignatureBase64, "base64").toString("utf8"))
        .toBe("AQID");
      expect(JSON.stringify(loginToken)).not.toContain(RFC);
      expect(JSON.stringify(loginToken)).not.toContain("password");
      expect(() => signer.buildValidatedLoginToken({
        tokenUuid: TOKEN_UUID,
        actionUrl: LOGIN_ACTION,
      })).toThrow(expect.objectContaining({ code: "ACCESS_DENIED" }));
      return { kind: "safe-result" } as const;
    }, {
      env: ENV,
      store,
      decrypt,
      createCredential: () => credential,
      now: () => new Date("2026-09-08T12:00:00.000Z"),
    });

    expect(result).toEqual({ kind: "safe-result" });
    expect(events).toEqual([
      "prepare-and-start-audit",
      "decrypt",
      "decrypt",
      "decrypt",
      "callback",
      "sign-sha1",
      "finish-and-terminal-audit",
    ]);
    expect(credential.sign).toHaveBeenCalledWith(
      `${TOKEN_UUID}|${RFC}|${PORTAL_SERIAL}`,
      "sha1",
    );
    expect(() => escapedSigner!.buildValidatedLoginToken({
      tokenUuid: TOKEN_UUID,
      actionUrl: LOGIN_ACTION,
    })).toThrow(expect.objectContaining({ code: "ACCESS_DENIED" }));
    expect(store.finish).toHaveBeenCalledWith(expect.objectContaining({
      outcomeCode: "COMPLETED",
    }));
  });

  it("rejects plaintext defense-in-depth without invoking the decryptor", async () => {
    const prepared = { ...PREPARED, encryptedPrivateKey: "legacy-plaintext-key" };
    const store = storeWith(prepared);
    const decrypt = vi.fn(decryptFixture);
    const use = vi.fn();

    await expect(withSatNativePilotSigner(use, {
      env: ENV,
      store,
      decrypt,
      createCredential: () => validCredential(),
    })).rejects.toMatchObject({ code: "CREDENTIALS_UNAVAILABLE" });

    expect(decrypt).not.toHaveBeenCalled();
    expect(use).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(expect.objectContaining({
      outcomeCode: "CREDENTIALS_UNAVAILABLE",
    }));
  });

  it("validates the SAT form action and token before using the key", async () => {
    const store = storeWith();
    const credential = validCredential();

    await expect(withSatNativePilotSigner(async (signer) => {
      expect(() => signer.buildValidatedLoginToken({
        tokenUuid: TOKEN_UUID,
        actionUrl: "https://evil.example/collect",
      })).toThrow(expect.objectContaining({ code: "PORTAL_CONTRACT_CHANGED" }));
      expect(() => signer.buildValidatedLoginToken({
        tokenUuid: "bad-challenge",
        actionUrl: LOGIN_ACTION,
      })).toThrow(expect.objectContaining({ code: "PORTAL_CONTRACT_CHANGED" }));
      throw new Error("upstream body secret");
    }, {
      env: ENV,
      store,
      decrypt: decryptFixture,
      createCredential: () => credential,
      now: () => new Date("2026-09-08T12:00:00.000Z"),
    })).rejects.toMatchObject({ code: "UNEXPECTED" });

    expect(credential.sign).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(expect.objectContaining({
      outcomeCode: "UNEXPECTED",
    }));
  });

  it("rejects an expired or wrong-RFC FIEL before the callback", async () => {
    const expiredStore = storeWith();
    await expect(withSatNativePilotSigner(async () => undefined, {
      env: ENV,
      store: expiredStore,
      decrypt: decryptFixture,
      createCredential: () => ({
        ...validCredential(),
        certificate: () => ({
          ...validCredential().certificate(),
          validOn: () => false,
        }),
      }),
    })).rejects.toMatchObject({ code: "EFIRMA_EXPIRED" });
    expect(expiredStore.finish).toHaveBeenCalledWith(expect.objectContaining({
      outcomeCode: "EFIRMA_EXPIRED",
    }));

    const wrongRfcStore = storeWith();
    await expect(withSatNativePilotSigner(async () => undefined, {
      env: ENV,
      store: wrongRfcStore,
      decrypt: decryptFixture,
      createCredential: () => ({
        ...validCredential(),
        rfc: () => "BBB010101BBB",
      }),
    })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(wrongRfcStore.finish).toHaveBeenCalledWith(expect.objectContaining({
      outcomeCode: "ACCESS_DENIED",
    }));
  });

  it("does not report success when terminal audit or release fails", async () => {
    const store = storeWith();
    vi.mocked(store.finish).mockRejectedValueOnce(new Error("database details"));

    await expect(withSatNativePilotSigner(async () => "would-have-succeeded", {
      env: ENV,
      store,
      decrypt: decryptFixture,
      createCredential: () => validCredential(),
    })).rejects.toMatchObject({
      code: "UNEXPECTED",
      message: "Native SAT retrieval stopped because of an unexpected error.",
    });
  });

  it("rejects a CSD even when its certificate and key are otherwise valid", async () => {
    const store = storeWith();
    await expect(withSatNativePilotSigner(async () => undefined, {
      env: ENV,
      store,
      decrypt: decryptFixture,
      createCredential: () => ({ ...validCredential(), isFiel: () => false }),
    })).rejects.toMatchObject({ code: "CREDENTIALS_UNAVAILABLE" });
    expect(store.finish).toHaveBeenCalledWith(expect.objectContaining({
      outcomeCode: "CREDENTIALS_UNAVAILABLE",
    }));
  });
});

describe("SAT portal serial derivation", () => {
  it("takes the second nibble of every DER serial byte", () => {
    const hexadecimal = Buffer.from(PORTAL_SERIAL, "ascii").toString("hex");
    expect(portalSerialFromCertificateHex(hexadecimal)).toBe(PORTAL_SERIAL);
    expect(BigInt(`0x${hexadecimal}`).toString(10)).not.toBe(PORTAL_SERIAL);
  });

  it.each(["", "0x", "123", "GG", "4A42"])(
    "rejects a serial that cannot produce SAT decimal digits: %s",
    (hexadecimal) => {
      expect(() => portalSerialFromCertificateHex(hexadecimal)).toThrow(
        expect.objectContaining({ code: "CREDENTIALS_UNAVAILABLE" }),
      );
    },
  );
});
