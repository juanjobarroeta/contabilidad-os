import { request as nodeHttpsRequest } from "node:https";
import { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { describe, expect, it, vi } from "vitest";
import {
  assertSatPilotTlsPeerEvidence,
  createSatPilotTlsAgentForTest,
  SatPilotTransport,
  type SatPilotFetch,
  type SatPilotTlsPeerEvidence,
} from "./transport";
import { satPilotEfirmaLoginUrl, satPilotEntryUrl } from "./routes";

const PASSWORD_LOGIN =
  "https://login.siat.sat.gob.mx/nidp/idff/sso" +
  "?id=mat-ptsc-totp_Aviso&sid=0&sid=0&option=credential";
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
const TOKEN_UUID = Buffer.from(
  "007d4ca0-465c-40e3-951b-c27bb5b1c343",
  "utf8",
).toString("base64");

function validLoginBody(): string {
  const form = new URLSearchParams();
  for (const [name, value] of [
    ["token", "VE9LRU4="],
    ["credentialsRequired", "CERT"],
    ["guid", TOKEN_UUID],
    ["ks", "null"],
    ["seeder", ""],
    ["arc", ""],
    ["tan", ""],
    ["placer", ""],
    ["secuence", ""],
    ["urlApplet", "https://login.siat.sat.gob.mx/nidp/app/login?id=fiel_Aviso"],
    ["jcaptcha", ""],
    ["fert", "290828004113Z"],
  ] as const) {
    form.append(name, value);
  }
  return form.toString();
}

function html(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
  });
}

function strongCertificateChain(): SatPilotTlsPeerEvidence["certificate"] {
  const fingerprint = (byte: string) => Array(32).fill(byte).join(":");
  const root: {
    bits: number;
    modulus: string;
    exponent: string;
    fingerprint256: string;
    issuerCertificate?: SatPilotTlsPeerEvidence["certificate"];
  } = {
    bits: 2_048,
    modulus: "A".repeat(512),
    exponent: "0x10001",
    fingerprint256: fingerprint("AA"),
  };
  root.issuerCertificate = root;
  return {
    bits: 2_048,
    modulus: "B".repeat(512),
    exponent: "0x10001",
    fingerprint256: fingerprint("BB"),
    issuerCertificate: root,
  };
}

function validTlsEvidence(): SatPilotTlsPeerEvidence {
  return {
    authorized: true,
    protocol: "TLSv1.2",
    cipherName: "DHE-RSA-AES256-GCM-SHA384",
    ephemeralKey: { type: "DH", size: 1_024 },
    certificate: strongCertificateChain(),
  };
}

describe("SatPilotTransport", () => {
  it("confines the SAT TLS exception to 1024-bit DH with a strong RSA chain", () => {
    expect(() => assertSatPilotTlsPeerEvidence(validTlsEvidence())).not.toThrow();
    expect(() => assertSatPilotTlsPeerEvidence({
      ...validTlsEvidence(),
      ephemeralKey: { type: "DH", size: 768 },
    })).toThrow(expect.objectContaining({ code: "PORTAL_CONTRACT_CHANGED" }));
    expect(() => assertSatPilotTlsPeerEvidence({
      ...validTlsEvidence(),
      certificate: {
        ...strongCertificateChain(),
        bits: 1_024,
        modulus: "C".repeat(256),
      },
    })).toThrow(expect.objectContaining({ code: "PORTAL_CONTRACT_CHANGED" }));
  });

  it("releases zero HTTP bytes when TLS evidence fails before socket handoff", async () => {
    let receivedBytes = 0;
    const socket = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.byteLength;
        callback();
      },
    }) as Duplex & {
      authorized: boolean;
      getProtocol: () => string;
      getCipher: () => { name: string };
      getEphemeralKeyInfo: () => { type: string; size: number };
      getPeerCertificate: () => SatPilotTlsPeerEvidence["certificate"];
    };
    socket.authorized = true;
    socket.getProtocol = () => "TLSv1.2";
    socket.getCipher = () => ({ name: "DHE-RSA-AES256-GCM-SHA384" });
    socket.getEphemeralKeyInfo = () => ({ type: "DH", size: 768 });
    socket.getPeerCertificate = () => strongCertificateChain();

    const agent = createSatPilotTlsAgentForTest(
      () => socket as unknown as TLSSocket,
    );
    const requestError = new Promise<Error>((resolve, reject) => {
      const request = nodeHttpsRequest(
        "https://login.siat.sat.gob.mx/nidp/idff/sso",
        { method: "POST", agent },
        () => reject(new Error("request unexpectedly reached an HTTP response")),
      );
      request.once("error", resolve);
      request.end("signed-form-body");
      queueMicrotask(() => socket.emit("secureConnect"));
    });

    await expect(requestError).resolves.toMatchObject({
      code: "PORTAL_CONTRACT_CHANGED",
    });
    expect(receivedBytes).toBe(0);
    agent.destroy();
  });

  it("follows only validated redirects and keeps cookies on their exact origin", async () => {
    const seen: Array<{ url: string; method?: string; cookie?: string }> = [];
    const fetchFn: SatPilotFetch = vi.fn(async (url, init) => {
      const headers = init.headers as Record<string, string>;
      seen.push({ url, method: init.method, cookie: headers.Cookie });
      if (url === satPilotEntryUrl()) {
        return html("", {
          status: 302,
          headers: { location: BRIDGE, "set-cookie": "ENTRY_ONLY=secret; Path=/; Secure; HttpOnly" },
        });
      }
      if (url === BRIDGE) {
        return html("", { status: 302, headers: { location: SSO_INIT } });
      }
      if (url === SSO_INIT) {
        return html("<form method=post></form>", {
          headers: { "set-cookie": "LOGIN_ONLY=session; Path=/nidp; Secure; HttpOnly" },
        });
      }
      if (url === PASSWORD_LOGIN && init.method === "POST") {
        return html("<button id=buttonFiel type=button>e.firma</button>", {
          headers: { "set-cookie": "LOGIN_NEXT=ready; Path=/nidp; Secure; HttpOnly" },
        });
      }
      return html("<form id=certform>e.firma</form>");
    });

    const transport = new SatPilotTransport({ fetchFn });
    const result = await transport.getCeEntry();
    expect(result).toMatchObject({
      routeId: "CE_SSO_INIT_PAGE",
      status: 200,
    });
    const password = await transport.postPasswordTransition(PASSWORD_LOGIN, SSO_INIT);
    expect(password).toMatchObject({ routeId: "CE_PASSWORD_LOGIN_PAGE" });
    const efirma = await transport.getEfirmaLogin(PASSWORD_LOGIN);
    expect(efirma).toMatchObject({
      routeId: "CE_EFIRMA_LOGIN_PAGE",
      status: 200,
    });
    expect(seen).toEqual([
      { url: satPilotEntryUrl(), method: "GET", cookie: undefined },
      { url: BRIDGE, method: "GET", cookie: "ENTRY_ONLY=secret" },
      { url: SSO_INIT, method: "GET", cookie: undefined },
      { url: PASSWORD_LOGIN, method: "POST", cookie: "LOGIN_ONLY=session" },
      {
        url: satPilotEfirmaLoginUrl(),
        method: "GET",
        cookie: "LOGIN_ONLY=session; LOGIN_NEXT=ready",
      },
    ]);
  });

  it("rejects an off-list redirect before sending the next request", async () => {
    const fetchFn: SatPilotFetch = vi.fn(async () => html("", {
      status: 302,
      headers: { location: "https://evil.example/collect" },
    }));
    const transport = new SatPilotTransport({ fetchFn });

    await expect(transport.getCeEntry()).rejects.toMatchObject({
      code: "PORTAL_CONTRACT_CHANGED",
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("rejects an off-list form action before transmitting its body", async () => {
    const fetchFn: SatPilotFetch = vi.fn();
    const transport = new SatPilotTransport({ fetchFn });
    await expect(transport.probeLoginForm(
      "https://evil.example/login",
      "signed=secret",
      satPilotEfirmaLoginUrl(),
    ))
      .rejects.toMatchObject({ code: "PORTAL_CONTRACT_CHANGED" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("redacts and does not follow the first authenticated redirect", async () => {
    const fetchFn: SatPilotFetch = vi.fn(async () => html("private", {
      status: 302,
      headers: {
        location:
          "https://wwwmat.sat.gob.mx/nesp/idff/sso" +
          "?SAMLart=secret-value&RelayState=other-secret",
        "set-cookie": "AUTH=private-cookie; Path=/; Secure; HttpOnly",
      },
    }));
    const result = await new SatPilotTransport({ fetchFn }).probeLoginForm(
      satPilotEfirmaLoginUrl(),
      validLoginBody(),
      satPilotEfirmaLoginUrl(),
    );

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      routeId: "CE_EFIRMA_LOGIN_SUBMIT",
      status: 302,
      body: "",
      unfollowedRedirect: {
        kind: "SAT_ROUTE_UNMAPPED",
        hostClass: "WWW_MAT",
        pathClass: "MAT_SSO_ASSERTION_CONSUMER",
        pathSegmentCount: 3,
        queryKeyClasses: ["RelayState", "SAMLart"],
        queryKeyCount: 2,
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("private-cookie");
  });

  it.each([307, 308] as const)(
    "never replays a signed body across a preserved-method %s redirect",
    async (status) => {
      const fetchFn: SatPilotFetch = vi.fn(async () => html("", {
        status,
        headers: {
          location:
            "https://wwwmat.sat.gob.mx/nesp/idff/sso" +
            "?SAMLart=private-ticket&RelayState=private-state",
        },
      }));
      const result = await new SatPilotTransport({ fetchFn }).probeLoginForm(
        satPilotEfirmaLoginUrl(),
        validLoginBody(),
        satPilotEfirmaLoginUrl(),
      );

      expect(fetchFn).toHaveBeenCalledOnce();
      expect(result.status).toBe(status);
      expect(result.unfollowedRedirect).toMatchObject({
        kind: "SAT_ROUTE_UNMAPPED",
        pathClass: "MAT_SSO_ASSERTION_CONSUMER",
      });
    },
  );

  it("rejects visible credential fields before transmitting a login form", async () => {
    const fetchFn: SatPilotFetch = vi.fn();
    const transport = new SatPilotTransport({ fetchFn });
    await expect(transport.probeLoginForm(
      satPilotEfirmaLoginUrl(),
      `${validLoginBody()}&rfc=AAA010101AAA&privateKeyPassword=secret`,
      satPilotEfirmaLoginUrl(),
    )).rejects.toMatchObject({ code: "PORTAL_CONTRACT_CHANGED" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects unexpected content types and oversized bodies", async () => {
    const jsonFetch: SatPilotFetch = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(new SatPilotTransport({ fetchFn: jsonFetch }).getCeEntry())
      .rejects.toMatchObject({ code: "PORTAL_CONTRACT_CHANGED" });

    const largeFetch: SatPilotFetch = vi.fn(async () => html("x".repeat(2_000)));
    await expect(new SatPilotTransport({ fetchFn: largeFetch, maxBodyBytes: 1_024 }).getCeEntry())
      .rejects.toMatchObject({ code: "PORTAL_CONTRACT_CHANGED" });
  });

  it("classifies rate limits and server outages without upstream details", async () => {
    const rateLimited: SatPilotFetch = vi.fn(async () => html("private", { status: 429 }));
    await expect(new SatPilotTransport({ fetchFn: rateLimited }).getCeEntry())
      .rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });

    const unavailable: SatPilotFetch = vi.fn(async () => html("private", { status: 503 }));
    await expect(new SatPilotTransport({ fetchFn: unavailable }).getCeEntry())
      .rejects.toMatchObject({ code: "PORTAL_UNAVAILABLE", retryable: true });
  });
});
