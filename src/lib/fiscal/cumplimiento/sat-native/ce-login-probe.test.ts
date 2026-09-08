import { describe, expect, it, vi } from "vitest";
import type { SatNativePilotSigner } from "./credential-broker";
import {
  SAT_NATIVE_PILOT_ACKNOWLEDGEMENT,
  SAT_NATIVE_PILOT_EXECUTION_SCOPE,
  withSatNativePilotSignerForTest,
  type PreparedSatNativeCredential,
  type SatNativeCredentialBrokerOptions,
  type SatNativeCredentialStore,
} from "./credential-broker";
import {
  runSatNativeCeFirstSignedPostProbeForTest as runSatNativeCeFirstPostProbe,
} from "./ce-login-probe";
import { satPilotEfirmaLoginUrl, satPilotEntryUrl } from "./routes";
import { SatPilotTransport, type SatPilotFetch } from "./transport";

const TOKEN_UUID = Buffer.from(
  "007d4ca0-465c-40e3-951b-c27bb5b1c343",
  "utf8",
).toString("base64");
const RFC = "AAA010101AAA";
const RUN_ID = "b4a2c9ee-55b7-4ad5-a567-9ad5fb77f431";
const PASSWORD_LOGIN = (() => {
  const url = new URL("https://login.siat.sat.gob.mx/nidp/idff/sso");
  url.searchParams.append("id", "mat-ptsc-totp_Aviso");
  url.searchParams.append("sid", "0");
  url.searchParams.append("option", "credential");
  url.searchParams.append("sid", "0");
  url.searchParams.append("target", satPilotEntryUrl());
  return url.href;
})();
const BRIDGE = (() => {
  const url = new URL("https://wwwmat.sat.gob.mx/nesp/app/plogin");
  url.searchParams.set("agAppNa", "PTSC");
  url.searchParams.set("c", "mat/ptsc/totp/aviso/uri");
  url.searchParams.set("target", `"${satPilotEntryUrl()}"`);
  return url.href;
})();
const SSO_INIT = (() => {
  const url = new URL("https://login.siat.sat.gob.mx/nidp/idff/sso");
  for (const [key, value] of Object.entries({
    RequestID: "id-Abcdefghijklmnopqrstuvwxyz12",
    MajorVersion: "1",
    MinorVersion: "2",
    IssueInstant: "2026-09-08T17:49:20Z",
    ProviderID: "https://wwwmat.sat.gob.mx:443/nesp/idff/metadata",
    RelayState: "MA==",
    consent: "urn:liberty:consent:unavailable",
    agAppNa: "PTSC",
    ForceAuthn: "false",
    IsPassive: "false",
    NameIDPolicy: "onetime",
    ProtocolProfile: "http://projectliberty.org/profiles/brws-art",
    target: satPilotEntryUrl(),
    AuthnContextStatementRef: "mat/ptsc/totp/aviso/uri",
  })) url.searchParams.set(key, value);
  return url.href;
})();

const SSO_HTML = [
  `<form method="POST" action="${PASSWORD_LOGIN.replaceAll("&", "&amp;")}"></form>`,
  "<script>document.forms[0].submit();</script>",
].join("\n");
const PASSWORD_HTML = '<button type="button" id="buttonFiel">e.firma</button>';
const EFIRMA_HTML = [
  '<input type="file" id="fileCertificate">',
  '<input type="file" id="filePrivateKey">',
  '<input type="password" id="privateKeyPassword" name="privateKeyPassword">',
  '<input type="text" id="rfc" name="rfc">',
  '<input type="button" id="submit" name="submit">',
  '<form id="certform" method="post">',
  `<input type="hidden" id="tokenuuid" value="${TOKEN_UUID}">`,
  '<input type="hidden" id="token" name="token">',
  '<input type="hidden" id="credentialsRequired" name="credentialsRequired" value="CERT">',
  `<input type="hidden" id="guid" name="guid" value="${TOKEN_UUID}">`,
  '<input type="hidden" id="ks" name="ks" value="null">',
  '<input type="hidden" id="seeder" name="seeder">',
  '<input type="hidden" id="arc" name="arc">',
  '<input type="hidden" id="tan" name="tan">',
  '<input type="hidden" id="placer" name="placer">',
  '<input type="hidden" id="secuence" name="secuence">',
  '<input type="hidden" id="urlApplet" name="urlApplet" value="https://login.siat.sat.gob.mx/nidp/app/login?id=fiel_Aviso">',
  '<input type="hidden" id="jcaptcha" name="jcaptcha">',
  '<input type="hidden" id="fert" name="fert">',
  "</form>",
].join("\n");

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
  });
}

function transportFor(postResponse: Response) {
  const fetchFn = vi.fn<SatPilotFetch>(async (url, init) => {
    if (url === satPilotEntryUrl()) {
      return html("", { status: 302, headers: { location: BRIDGE } });
    }
    if (url === BRIDGE) {
      return html("", { status: 302, headers: { location: SSO_INIT } });
    }
    if (url === SSO_INIT) return html(SSO_HTML);
    if (url === PASSWORD_LOGIN && init.method === "POST") return html(PASSWORD_HTML);
    if (url === satPilotEfirmaLoginUrl() && init.method === "GET") {
      return html(EFIRMA_HTML);
    }
    if (url === satPilotEfirmaLoginUrl() && init.method === "POST") {
      return postResponse;
    }
    throw new Error("unexpected test route");
  });
  return { transport: new SatPilotTransport({ fetchFn }), fetchFn };
}

function fakeSignerBoundary() {
  const signer: SatNativePilotSigner = {
    buildValidatedLoginToken: vi.fn(() => ({
      token: "VE9LRU4=",
      fert: "290828004113Z",
    })),
  };
  const boundary = async <T>(
    use: (value: SatNativePilotSigner) => Promise<T>,
  ): Promise<T> => use(signer);
  return { signer, boundary };
}

function auditedBrokerOptions(): Readonly<{
  options: SatNativeCredentialBrokerOptions;
  store: SatNativeCredentialStore;
}> {
  const prepared: PreparedSatNativeCredential = {
    companyId: "company-1",
    rfc: RFC,
    actorEmail: "operator@example.test",
    encryptedCertificate: "enc:v1:certificate",
    encryptedPrivateKey: "enc:v1:private-key",
    encryptedPassword: "enc:v1:password",
  };
  const store: SatNativeCredentialStore = {
    prepare: vi.fn(async () => prepared),
    finish: vi.fn(async () => undefined),
  };
  const decrypted: Record<string, string> = {
    "enc:v1:certificate": Buffer.from("certificate").toString("base64"),
    "enc:v1:private-key": Buffer.from("private-key").toString("base64"),
    "enc:v1:password": "synthetic-test-password",
  };
  return {
    store,
    options: {
      env: {
        SAT_NATIVE_PILOT_ENABLED: "true",
        SAT_NATIVE_PILOT_RFC: RFC,
        SAT_NATIVE_PILOT_OPERATOR_USER_ID: "operator-1",
        SAT_NATIVE_PILOT_RUN_ID: RUN_ID,
        SAT_NATIVE_PILOT_ACKNOWLEDGEMENT,
        SAT_NATIVE_PILOT_EXECUTION_SCOPE,
      },
      store,
      decrypt: (stored) => decrypted[stored] ?? "",
      createCredential: () => ({
        isFiel: () => true,
        rfc: () => RFC,
        certificate: () => ({
          validOn: () => true,
          validTo: () => new Date("2029-08-28T00:41:13.000Z"),
          serialNumber: () => ({
            hexadecimal: () => Buffer.from(
              "30001000000400000123",
              "ascii",
            ).toString("hex"),
          }),
        }),
        sign: () => "\x01\x02\x03",
      }),
      now: () => new Date("2026-09-08T18:30:00.000Z"),
    },
  };
}

describe("SAT native CE first-signed-post probe", () => {
  it("returns only a redacted redirect shape and disposes the session", async () => {
    const { transport, fetchFn } = transportFor(html("", {
      status: 302,
      headers: {
        location:
          "https://wwwmat.sat.gob.mx/nesp/idff/sso" +
          "?SAMLart=private-ticket&RelayState=private-state",
      },
    }));
    const { signer, boundary } = fakeSignerBoundary();

    const result = await runSatNativeCeFirstPostProbe({
      transport,
      signerBoundary: boundary,
      now: () => new Date("2026-09-08T18:30:00.000Z"),
    });

    expect(result).toEqual({
      ok: true,
      operation: "LIST_ELECTRONIC_ACCOUNTING",
      value: {
        state: "FIRST_REDIRECT_OBSERVED",
        surface: "BUZON_TRIBUTARIO_CE",
        credentialUsed: true,
        authenticated: false,
        observedAt: "2026-09-08T18:30:00.000Z",
        httpStatus: 302,
        redirect: {
          kind: "SAT_ROUTE_UNMAPPED",
          hostClass: "WWW_MAT",
          pathClass: "MAT_SSO_ASSERTION_CONSUMER",
          pathSegmentCount: 3,
          queryKeyClasses: ["RelayState", "SAMLart"],
          queryKeyCount: 2,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-ticket");
    expect(JSON.stringify(result)).not.toContain(TOKEN_UUID);
    expect(fetchFn).toHaveBeenCalledTimes(6);
    expect(signer.buildValidatedLoginToken).toHaveBeenCalledWith({
      tokenUuid: TOKEN_UUID,
      actionUrl: satPilotEfirmaLoginUrl(),
    });
    await expect(transport.getCeEntry()).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
  });

  it("classifies a returned e.firma form as rejected authentication", async () => {
    const { transport } = transportFor(html(EFIRMA_HTML));
    const { boundary } = fakeSignerBoundary();
    const result = await runSatNativeCeFirstPostProbe({
      transport,
      signerBoundary: boundary,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "AUTH_REJECTED", retryable: false },
    });
  });

  it("rejects an off-domain redirect without exposing it", async () => {
    const { transport } = transportFor(html("", {
      status: 302,
      headers: { location: "https://evil.example/collect?token=private" },
    }));
    const { boundary } = fakeSignerBoundary();
    const result = await runSatNativeCeFirstPostProbe({
      transport,
      signerBoundary: boundary,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PORTAL_CONTRACT_CHANGED" },
    });
    expect(JSON.stringify(result)).not.toContain("evil.example");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("never exposes transient state embedded in a SAT hostname or path", async () => {
    const { transport } = transportFor(html("", {
      status: 302,
      headers: {
        location:
          "https://private-ticket.sat.gob.mx/session/private-path" +
          "?privateKey=private-value&SAMLart=another-private-value",
      },
    }));
    const { boundary } = fakeSignerBoundary();
    const result = await runSatNativeCeFirstPostProbe({
      transport,
      signerBoundary: boundary,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        redirect: {
          kind: "SAT_ROUTE_UNMAPPED",
          hostClass: "OTHER_SAT",
          pathClass: "UNMAPPED",
          pathSegmentCount: 2,
          queryKeyClasses: ["SAMLart", "UNMAPPED"],
          queryKeyCount: 2,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("ticket");
  });

  it.each([
    ["AUTH_REJECTED", () => html(EFIRMA_HTML)],
    ["NEEDS_USER_ACTION", () => html('<input id="otp" type="text">')],
    [
      "PORTAL_CONTRACT_CHANGED",
      () => html("", {
        status: 302,
        headers: { location: "https://evil.example/private" },
      }),
    ],
  ] as const)(
    "writes the terminal broker outcome that matches %s",
    async (expectedCode, responseFactory) => {
      const { transport } = transportFor(responseFactory());
      const { options, store } = auditedBrokerOptions();
      const result = await runSatNativeCeFirstPostProbe({
        transport,
        signerBoundary: (use) => withSatNativePilotSignerForTest(use, options),
        credentialBrokerOptions: options,
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: expectedCode },
      });
      expect(store.finish).toHaveBeenCalledWith(expect.objectContaining({
        outcomeCode: expectedCode,
      }));
    },
  );
});
