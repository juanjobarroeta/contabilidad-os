import { describe, expect, it } from "vitest";
import { SatReadError } from "./errors";
import {
  assertSatPilotLoginAction,
  assertSatPilotPasswordTransitionAction,
  assertSatPilotRoute,
  satPilotEfirmaLoginUrl,
  satPilotEntryUrl,
} from "./routes";

const PASSWORD_LOGIN =
  "https://login.siat.sat.gob.mx/nidp/idff/sso" +
  "?id=mat-ptsc-totp_Aviso&sid=0&sid=0&option=credential";
const EFIRMA_LOGIN = satPilotEfirmaLoginUrl();
const BRIDGE = (() => {
  const url = new URL("https://wwwmat.sat.gob.mx/nesp/app/plogin");
  url.searchParams.set("agAppNa", "PTSC");
  url.searchParams.set("c", "mat/ptsc/totp/aviso/uri");
  url.searchParams.set("target", `"${satPilotEntryUrl()}"`);
  return url.href;
})();
const SSO_INIT = (() => {
  const url = new URL("https://login.siat.sat.gob.mx/nidp/idff/sso");
  const values: Record<string, string> = {
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
  };
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url.href;
})();

function expectContractChange(fn: () => unknown) {
  expect(fn).toThrowError(
    expect.objectContaining<Partial<SatReadError>>({
      code: "PORTAL_CONTRACT_CHANGED",
      operation: "LIST_ELECTRONIC_ACCOUNTING",
    }),
  );
}

describe("SAT native CE route allowlist", () => {
  it("allows only the observed public entry", () => {
    expect(assertSatPilotRoute(satPilotEntryUrl(), "GET")).toEqual({
      id: "CE_ENTRY",
      origin: "https://wwwmat.sat.gob.mx",
      method: "GET",
    });
    expectContractChange(() => assertSatPilotRoute(`${satPilotEntryUrl()}?download=1`, "GET"));
    expectContractChange(() => assertSatPilotRoute(satPilotEntryUrl(), "POST"));
  });

  it("allows the password landing only for the fixed public transition", () => {
    const target = encodeURIComponent(satPilotEntryUrl());
    expect(assertSatPilotRoute(`${PASSWORD_LOGIN}&target=${target}`, "GET").id)
      .toBe("CE_PASSWORD_LOGIN_PAGE");
    expect(assertSatPilotPasswordTransitionAction(PASSWORD_LOGIN).id)
      .toBe("CE_PASSWORD_LOGIN_PAGE");
  });

  it("allows only the exact CE bridge and constrained dynamic SSO initiation", () => {
    expect(assertSatPilotRoute(BRIDGE, "GET").id)
      .toBe("CE_PORTAL_LOGIN_BRIDGE");
    expect(assertSatPilotRoute(SSO_INIT, "GET").id)
      .toBe("CE_SSO_INIT_PAGE");
    expectContractChange(() => assertSatPilotRoute(
      SSO_INIT.replace("RequestID=id", "RequestID=bad"),
      "GET",
    ));
    expectContractChange(() => assertSatPilotRoute(
      `${SSO_INIT}&next=https%3A%2F%2Fevil.example`,
      "GET",
    ));
  });

  it("allows only the separate e.firma realm as a form action", () => {
    expect(assertSatPilotRoute(EFIRMA_LOGIN, "GET").id)
      .toBe("CE_EFIRMA_LOGIN_PAGE");
    expect(assertSatPilotLoginAction(EFIRMA_LOGIN).id)
      .toBe("CE_EFIRMA_LOGIN_SUBMIT");
  });

  it("allows only observed same-origin login assets", () => {
    expect(assertSatPilotRoute(
      "https://login.siat.sat.gob.mx/nidp/x509SAT/js/sjcl/sha1.js",
      "GET",
    ).id).toBe("CE_LOGIN_ASSET");
    expectContractChange(() => assertSatPilotRoute(
      "https://login.siat.sat.gob.mx/nidp/x509SAT/js/unobserved.js",
      "GET",
    ));
  });

  it.each([
    "http://login.siat.sat.gob.mx/nidp/idff/sso?id=mat-ptsc-totp_Aviso&sid=0&sid=0&option=credential",
    "https://login.siat.sat.gob.mx.evil.example/nidp/idff/sso?id=mat-ptsc-totp_Aviso&sid=0&sid=0&option=credential",
    "https://user:pass@login.siat.sat.gob.mx/nidp/idff/sso?id=mat-ptsc-totp_Aviso&sid=0&sid=0&option=credential",
    "https://login.siat.sat.gob.mx:444/nidp/idff/sso?id=mat-ptsc-totp_Aviso&sid=0&sid=0&option=credential",
    "https://127.0.0.1/nidp/idff/sso?id=mat-ptsc-totp_Aviso&sid=0&sid=0&option=credential",
    "https://login.siat.sat.gob.mx/nidp/%2e%2e/admin?id=mat-ptsc-totp_Aviso&sid=0&sid=0&option=credential",
    "https://login.siat.sat.gob.mx/nidp%2fidff/sso?id=mat-ptsc-totp_Aviso&sid=0&sid=0&option=credential",
  ])("rejects unsafe or lookalike URL %s", (url) => {
    expectContractChange(() => assertSatPilotRoute(url, "GET"));
  });

  it.each([
    `${EFIRMA_LOGIN}&next=https%3A%2F%2Fevil.example`,
    `${EFIRMA_LOGIN}&id=another`,
    `${EFIRMA_LOGIN.replace("sid=0&option=credential&sid=0", "sid=0&option=credential")}`,
    `${EFIRMA_LOGIN}&target=${encodeURIComponent(satPilotEntryUrl())}`,
  ])("rejects query smuggling or changed login state %s", (url) => {
    expectContractChange(() => assertSatPilotRoute(url, "POST"));
  });

  it("rejects every mutation-looking SAT path even on an allowed host", () => {
    expectContractChange(() => assertSatPilotRoute(
      "https://wwwmat.sat.gob.mx/operacion/42150/envia-tu-contabilidad-electronica",
      "POST",
    ));
  });
});
