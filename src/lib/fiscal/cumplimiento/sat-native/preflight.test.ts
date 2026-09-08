import { describe, expect, it, vi } from "vitest";
import {
  assertCeEfirmaLoginDocument,
  buildSatNativeCeLoginSubmission,
  runSatNativeCePublicPreflight,
} from "./preflight";
import { satPilotEfirmaLoginUrl, satPilotEntryUrl } from "./routes";
import { SatPilotTransport, type SatPilotFetch } from "./transport";

const PASSWORD_LOGIN =
  "https://login.siat.sat.gob.mx/nidp/idff/sso" +
  "?id=mat-ptsc-totp_Aviso&sid=0&option=credential&sid=0" +
  `&target=${encodeURIComponent(satPilotEntryUrl())}`;
const PASSWORD_HTML = '<button type="button" id="buttonFiel">e.firma</button>';
const TOKEN_UUID = Buffer.from(
  "007d4ca0-465c-40e3-951b-c27bb5b1c343",
  "utf8",
).toString("base64");
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
    RequestID: "idAbcdefghijklmnopqrstuvwxyz12",
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
  `<form action="${PASSWORD_LOGIN.replaceAll("&", "&amp;")}" method="post"></form>`,
  "<script>document.forms[0].submit();</script>",
].join("\n");

const LOGIN_HTML = [
  "<!doctype html>",
  '<input type="file" id="fileCertificate">',
  "<input id='filePrivateKey' type='file'>",
  "<input type=password id=privateKeyPassword name=privateKeyPassword>",
  '<input id="rfc" name="rfc" type="text">',
  '<input id="submit" name="submit" type="button">',
  '<form id="certform" method="post">',
  `<input id="tokenuuid" type="hidden" value="${TOKEN_UUID}">`,
  '<input id="token" type="hidden" name="token">',
  '<input id="credentialsRequired" type="hidden" name="credentialsRequired" value="CERT">',
  `<input id="guid" type="hidden" name="guid" value="${TOKEN_UUID}">`,
  '<input id="ks" type="hidden" name="ks" value="null">',
  '<input id="seeder" type="hidden" name="seeder">',
  '<input id="arc" type="hidden" name="arc">',
  '<input id="tan" type="hidden" name="tan">',
  '<input id="placer" type="hidden" name="placer">',
  '<input id="secuence" type="hidden" name="secuence">',
  '<input id="urlApplet" type="hidden" name="urlApplet" value="https://login.siat.sat.gob.mx/nidp/app/login?id=fiel_Aviso">',
  '<input id="jcaptcha" type="hidden" name="jcaptcha">',
  '<input id="fert" type="hidden" name="fert">',
  "</form>",
].join("\n");

function html(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
  });
}

function redirectingFetch(
  loginHtml = LOGIN_HTML,
  passwordHtml = PASSWORD_HTML,
  ssoHtml = SSO_HTML,
): SatPilotFetch {
  return vi.fn(async (url, init) => {
    if (url === satPilotEntryUrl()) {
      return html("", {
        status: 302,
        headers: { location: BRIDGE },
      });
    }
    if (url === BRIDGE) {
      return html("", { status: 302, headers: { location: SSO_INIT } });
    }
    if (url === SSO_INIT) return html(ssoHtml);
    if (url === PASSWORD_LOGIN && init.method === "POST") return html(passwordHtml);
    if (url === satPilotEfirmaLoginUrl()) return html(loginHtml);
    throw new Error("unexpected test route");
  });
}

describe("SAT native public CE preflight", () => {
  it("reports readiness without claiming authentication or credential use", async () => {
    const fetchFn = redirectingFetch();
    const transport = new SatPilotTransport({ fetchFn });
    const result = await runSatNativeCePublicPreflight(
      transport,
      () => new Date("2026-09-08T12:00:00.000Z"),
    );

    expect(result).toEqual({
      ok: true,
      operation: "LIST_ELECTRONIC_ACCOUNTING",
      value: {
        state: "READY_FOR_AUTHORIZATION",
        surface: "BUZON_TRIBUTARIO_CE",
        loginMechanism: "EFIRMA_FILE_FORM",
        contractObservedAt: "2026-09-08",
        checkedAt: "2026-09-08T12:00:00.000Z",
        credentialUsed: false,
        authenticated: false,
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(5);
    await expect(transport.getCeEntry()).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
  });

  it.each([
    LOGIN_HTML.replace('id="fileCertificate"', 'id="otherCertificate"'),
    LOGIN_HTML.replace("<input id='filePrivateKey' type='file'>", ""),
    LOGIN_HTML.replace("type=password", "type=text"),
    LOGIN_HTML.replace(
      '<input id="rfc" name="rfc" type="text">',
      '<input id="rfc" name="rfc" type="text"><input id="rfc" name="rfc" type="text">',
    ),
    LOGIN_HTML.replace('name="secuence"', 'name="sequence"'),
    LOGIN_HTML.replace('id="tokenuuid"', 'id="other-token"'),
    LOGIN_HTML.replace(
      '<form id="certform" method="post">',
      '<form id="certform" method="post" action="https://evil.example/collect">',
    ),
    LOGIN_HTML.replace(
      `value="${TOKEN_UUID}"`,
      'value="unexpected"',
    ),
    LOGIN_HTML.replace(`name="guid" value="${TOKEN_UUID}"`, 'name="guid" value="other"'),
    LOGIN_HTML.replace('method="post"', 'method="get"'),
    LOGIN_HTML.replace(' method="post"', ""),
    LOGIN_HTML.replace('method="post"', 'method="post" method="post"'),
  ])("fails closed when the e.firma form contract changes", async (body) => {
    const result = await runSatNativeCePublicPreflight(
      new SatPilotTransport({ fetchFn: redirectingFetch(body) }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PORTAL_CONTRACT_CHANGED", retryable: false },
    });
  });

  it("fails closed when the password realm loses its fixed e.firma transition", async () => {
    const result = await runSatNativeCePublicPreflight(
      new SatPilotTransport({ fetchFn: redirectingFetch(LOGIN_HTML, "") }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PORTAL_CONTRACT_CHANGED" },
    });
  });

  it("stops for user action if SAT adds a visible challenge to e.firma", async () => {
    const challenged = LOGIN_HTML.replace(
      '<form id="certform" method="post">',
      '<input id="jcaptchainput" name="jcaptchainput" type="text"><form id="certform" method="post">',
    );
    const result = await runSatNativeCePublicPreflight(
      new SatPilotTransport({ fetchFn: redirectingFetch(challenged) }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "NEEDS_USER_ACTION", recovery: "USER" },
    });
  });

  it("fails closed when the SSO bootstrap attempts a non-empty or foreign post", async () => {
    const badSso = SSO_HTML.replace(
      "</form>",
      '<input name="credential" value="unexpected"></form>',
    );
    const result = await runSatNativeCePublicPreflight(
      new SatPilotTransport({
        fetchFn: redirectingFetch(LOGIN_HTML, PASSWORD_HTML, badSso),
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PORTAL_CONTRACT_CHANGED" },
    });
  });

  it("builds only SAT's hidden certform body and preserves validated fields", () => {
    const signer = {
      buildValidatedLoginToken: vi.fn(() => ({
        token: "VE9LRU4=",
        fert: "290828004113Z",
      })),
    };
    const submission = buildSatNativeCeLoginSubmission({
      routeId: "CE_EFIRMA_LOGIN_PAGE",
      status: 200,
      contentType: "text/html",
      body: LOGIN_HTML,
      requestUrl: satPilotEfirmaLoginUrl(),
    }, signer);

    expect(submission.actionUrl).toBe(satPilotEfirmaLoginUrl());
    const fields = new URLSearchParams(submission.formBody);
    expect(Object.fromEntries(fields)).toEqual({
      token: "VE9LRU4=",
      credentialsRequired: "CERT",
      guid: TOKEN_UUID,
      ks: "null",
      seeder: "",
      arc: "",
      tan: "",
      placer: "",
      secuence: "",
      urlApplet: "https://login.siat.sat.gob.mx/nidp/app/login?id=fiel_Aviso",
      jcaptcha: "",
      fert: "290828004113Z",
    });
    expect(fields.has("rfc")).toBe(false);
    expect(fields.has("fileCertificate")).toBe(false);
    expect(fields.has("filePrivateKey")).toBe(false);
    expect(fields.has("privateKeyPassword")).toBe(false);
    expect(signer.buildValidatedLoginToken).toHaveBeenCalledWith({
      tokenUuid: TOKEN_UUID,
      actionUrl: satPilotEfirmaLoginUrl(),
    });
  });

  it("rejects a document from any route other than the allowlisted login", () => {
    expect(() => assertCeEfirmaLoginDocument({
      routeId: "CE_ENTRY",
      status: 200,
      contentType: "text/html",
      body: LOGIN_HTML,
      requestUrl: satPilotEntryUrl(),
    })).toThrow(expect.objectContaining({ code: "PORTAL_CONTRACT_CHANGED" }));
  });
});
