import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import {
  connect as tlsConnect,
  type ConnectionOptions as TlsConnectionOptions,
  type TLSSocket,
} from "node:tls";
import contract from "./fixtures/ce-login-contract.2026-09-08.json";
import { SatReadError } from "./errors";
import {
  assertSatPilotLoginAction,
  assertSatPilotPasswordTransitionAction,
  assertSatPilotRoute,
  satPilotEfirmaLoginUrl,
  satPilotEntryUrl,
  type SatPilotHttpMethod,
  type SatPilotRouteId,
} from "./routes";

const OPERATION = "LIST_ELECTRONIC_ACCOUNTING" as const;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LEGACY_TLS_HOSTNAMES = new Set([
  "wwwmat.sat.gob.mx",
  "login.siat.sat.gob.mx",
]);
const SAT_PINNED_TLS12_CIPHER = "DHE-RSA-AES256-GCM-SHA384";
const SAT_PINNED_TLS12_CIPHER_CONFIG =
  `${SAT_PINNED_TLS12_CIPHER}:@SECLEVEL=1`;

export type SatPilotFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SatPilotHttpDocument {
  readonly routeId: SatPilotRouteId;
  readonly status: number;
  readonly contentType: string;
  /** Internal parser input. Never include this in logs, API output, or audit metadata. */
  readonly body: string;
  /** May contain transient public SSO state. Never log, persist, or return it. */
  readonly requestUrl: string;
  /** Present only for the supervised one-request login probe. */
  readonly unfollowedRedirect?: SatPilotUnfollowedRedirect;
}

export type SatPilotUnfollowedRedirect =
  | Readonly<{
      kind: "ALLOWLISTED_ROUTE";
      routeId: SatPilotRouteId;
    }>
  | Readonly<{
      kind: "SAT_ROUTE_UNMAPPED";
      hostClass: "WWW_MAT" | "LOGIN_SIAT" | "OTHER_SAT";
      pathClass: "MAT_SSO_ASSERTION_CONSUMER" | "UNMAPPED";
      pathSegmentCount: number;
      queryKeyClasses: readonly ("RelayState" | "SAMLart" | "UNMAPPED")[];
      queryKeyCount: number;
    }>
  | Readonly<{ kind: "OUTSIDE_ALLOWLIST" }>;

export interface SatPilotTransportOptions {
  readonly fetchFn?: SatPilotFetch;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxBodyBytes?: number;
}

interface SatPilotPeerCertificate {
  readonly bits?: number;
  readonly modulus?: string;
  readonly exponent?: string;
  readonly fingerprint256?: string;
  readonly issuerCertificate?: SatPilotPeerCertificate;
}

export interface SatPilotTlsPeerEvidence {
  readonly authorized: boolean;
  readonly protocol: string | null;
  readonly cipherName: string | undefined;
  readonly ephemeralKey: Readonly<{ type?: string; size?: number }> | null;
  readonly certificate: SatPilotPeerCertificate;
}

type SatPilotTlsConnect = (options: TlsConnectionOptions) => TLSSocket;

class SatPilotTlsAgent extends HttpsAgent {
  readonly #connect: SatPilotTlsConnect;

  constructor(connect: SatPilotTlsConnect = tlsConnect) {
    super({
      keepAlive: false,
      maxCachedSessions: 0,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
      ciphers: SAT_PINNED_TLS12_CIPHER_CONFIG,
    });
    this.#connect = connect;
  }

  override createConnection(
    options: import("node:https").RequestOptions,
    callback?: (error: Error | null, stream: import("node:stream").Duplex) => void,
  ): import("node:stream").Duplex | null | undefined {
    if (!callback) return undefined;
    const socket = this.#connect({
      ...options,
      host: options.host ?? undefined,
    } as TlsConnectionOptions);
    let released = false;
    const release = (error: Error | null) => {
      if (released) return;
      released = true;
      socket.removeListener("error", onHandshakeError);
      callback(error, socket);
    };
    const onHandshakeError = () => release(changed());
    socket.once("error", onHandshakeError);
    socket.once("secureConnect", () => {
      try {
        assertSatPilotTlsPeerEvidence(tlsPeerEvidence(socket));
        release(null);
      } catch {
        socket.destroy();
        release(changed());
      }
    });

    // Do not return the socket. The Agent receives it through the callback only
    // after validation, so ClientRequest cannot flush headers or body earlier.
    return undefined;
  }
}

/** Test-only factory for proving the pre-write TLS gate with a synthetic socket. */
export function createSatPilotTlsAgentForTest(
  connect: SatPilotTlsConnect,
): HttpsAgent {
  if (process.env.NODE_ENV !== "test") {
    throw new SatReadError("ACCESS_DENIED", OPERATION);
  }
  return new SatPilotTlsAgent(connect);
}

/**
 * Minimal HTTP transport for the CE evidence pilot. Redirects are always
 * manual, cookies never leave their exact origin, and callers cannot add
 * headers or initiate an arbitrary route.
 */
export class SatPilotTransport {
  readonly #fetchFn: SatPilotFetch;
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;
  readonly #maxBodyBytes: number;
  readonly #cookiesByOrigin = new Map<string, Map<string, StoredCookie>>();
  #disposed = false;

  constructor(options: SatPilotTransportOptions = {}) {
    if (options.fetchFn && process.env.NODE_ENV !== "test") {
      throw new SatReadError("ACCESS_DENIED", OPERATION);
    }
    this.#fetchFn = options.fetchFn ?? satPilotNodeFetch;
    this.#timeoutMs = boundedInteger(options.timeoutMs, 15_000, 1_000, 60_000);
    this.#maxRedirects = boundedInteger(options.maxRedirects, 6, 0, 10);
    this.#maxBodyBytes = boundedInteger(options.maxBodyBytes, 1_000_000, 1_024, 2_000_000);
  }

  /** Destroy all ephemeral portal state and make this transport unusable. */
  dispose(): void {
    this.#cookiesByOrigin.clear();
    this.#disposed = true;
  }

  getCeEntry(): Promise<SatPilotHttpDocument> {
    return this.#request(satPilotEntryUrl(), "GET");
  }

  /** Follow the public page's fixed e.firma transition in the same cookie jar. */
  getEfirmaLogin(refererUrl: string): Promise<SatPilotHttpDocument> {
    const refererRoute = assertSatPilotRoute(refererUrl, "GET");
    if (refererRoute.id !== "CE_PASSWORD_LOGIN_PAGE") throw changed();
    return this.#request(satPilotEfirmaLoginUrl(), "GET", undefined, refererUrl);
  }

  /** Execute only the empty auto-submit form emitted by SAT's SSO bootstrap. */
  async postPasswordTransition(
    actionUrl: string,
    refererUrl: string,
  ): Promise<SatPilotHttpDocument> {
    assertSatPilotPasswordTransitionAction(actionUrl);
    const refererRoute = assertSatPilotRoute(refererUrl, "GET");
    if (
      refererRoute.id !== "CE_SSO_INIT_PAGE" ||
      refererRoute.origin !== new URL(actionUrl).origin
    ) {
      throw changed();
    }
    return this.#request(actionUrl, "POST", "", refererUrl);
  }

  /**
   * Send exactly one e.firma POST and stop before its redirect. The redacted
   * observation contains no query values, cookies, response body, or token.
   */
  async probeLoginForm(
    actionUrl: string,
    formBody: string,
    refererUrl: string,
  ): Promise<SatPilotHttpDocument> {
    assertEfirmaSubmission(actionUrl, refererUrl, formBody);
    return this.#request(actionUrl, "POST", formBody, refererUrl, true);
  }

  async #request(
    initialUrl: string,
    initialMethod: SatPilotHttpMethod,
    initialBody?: string,
    initialReferer?: string,
    stopAtFirstRedirect = false,
  ): Promise<SatPilotHttpDocument> {
    if (this.#disposed) throw new SatReadError("ACCESS_DENIED", OPERATION);
    let currentUrl = initialUrl;
    let method = initialMethod;
    let body = initialBody;
    let referer = initialReferer;

    for (let redirects = 0; ; redirects += 1) {
      const route = assertSatPilotRoute(currentUrl, method);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

      let response: Response | null = null;
      try {
        const current = new URL(currentUrl);
        const cookie = this.#cookieHeader(current);
        const headers: Record<string, string> = { Accept: "text/html,application/xhtml+xml" };
        if (cookie) headers.Cookie = cookie;
        if (referer) headers.Referer = referer;
        if (method === "POST") {
          headers["Content-Type"] = "application/x-www-form-urlencoded";
          if (referer) {
            headers.Origin = route.origin;
          }
        }

        response = await this.#fetchFn(currentUrl, {
          method,
          headers,
          body: method === "POST" ? body : undefined,
          redirect: "manual",
          signal: controller.signal,
        });

        this.#captureCookies(current, response.headers);

        if (REDIRECT_STATUSES.has(response.status)) {
          if (redirects >= this.#maxRedirects) throw changed();
          const location = response.headers.get("location");
          if (!location) throw changed();

          const nextUrl = resolveRedirect(location, currentUrl);
          const nextMethod = redirectMethod(response.status, method);
          if (stopAtFirstRedirect) {
            await response.body?.cancel().catch(() => undefined);
            return {
              routeId: route.id,
              status: response.status,
              contentType: normalizedContentType(
                response.headers.get("content-type"),
              ),
              body: "",
              requestUrl: currentUrl,
              unfollowedRedirect: redactUnfollowedRedirect(nextUrl, nextMethod),
            };
          }
          await response.body?.cancel().catch(() => undefined);
          assertSatPilotRoute(nextUrl, nextMethod);
          currentUrl = nextUrl;
          method = nextMethod;
          if (method === "GET") body = undefined;
          referer = undefined;
          continue;
        }

        assertSuccessfulStatus(response.status);
        const contentType = normalizedContentType(response.headers.get("content-type"));
        if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
          throw changed();
        }

        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > this.#maxBodyBytes) {
          throw changed();
        }

        const bytes = await readLimitedBody(response, this.#maxBodyBytes);
        let decoded: string;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw changed();
        }
        return {
          routeId: route.id,
          status: response.status,
          contentType,
          body: decoded,
          requestUrl: currentUrl,
        };
      } catch (error) {
        await response?.body?.cancel().catch(() => undefined);
        if (error instanceof SatReadError) throw error;
        throw new SatReadError("PORTAL_UNAVAILABLE", OPERATION);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  #captureCookies(requestUrl: URL, headers: Headers): void {
    const compatible = headers as Headers & { getSetCookie?: () => string[] };
    const values = typeof compatible.getSetCookie === "function"
      ? compatible.getSetCookie()
      : headers.get("set-cookie")
        ? [headers.get("set-cookie")!]
        : [];
    if (values.length === 0) return;
    if (values.length > 64) throw changed();

    const jar = this.#cookiesByOrigin.get(requestUrl.origin) ??
      new Map<string, StoredCookie>();
    for (const value of values) {
      if (value.length > 16_384) throw changed();
      const parts = value.split(";").map((part) => part.trim());
      const pair = parts[0];
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      const pathAttribute = parts.find((part) => /^path=/i.test(part));
      const path = pathAttribute?.slice(5) || defaultCookiePath(requestUrl.pathname);
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\u0000-\u001F\u007F]/.test(cookieValue)) {
        throw changed();
      }
      if (!path.startsWith("/") || /[\u0000-\u001F\u007F;]/.test(path)) {
        throw changed();
      }
      const key = `${name}\u0000${path}`;
      if (
        cookieValue === "" ||
        parts.some((part) => /^max-age=0$/i.test(part))
      ) {
        jar.delete(key);
      } else {
        jar.set(key, { name, value: cookieValue, path });
      }
    }
    if (jar.size > 128) throw changed();
    this.#cookiesByOrigin.set(requestUrl.origin, jar);
  }

  #cookieHeader(url: URL): string | undefined {
    const jar = this.#cookiesByOrigin.get(url.origin);
    if (!jar || jar.size === 0) return undefined;
    const cookies = [...jar.values()]
      .filter((cookie) => cookiePathMatches(cookie.path, url.pathname))
      .sort((left, right) => right.path.length - left.path.length);
    return cookies.length > 0
      ? cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
      : undefined;
  }
}

function assertEfirmaSubmission(
  actionUrl: string,
  refererUrl: string,
  formBody: string,
): void {
  const actionRoute = assertSatPilotLoginAction(actionUrl);
  const refererRoute = assertSatPilotRoute(refererUrl, "GET");
  if (
    refererRoute.id !== "CE_EFIRMA_LOGIN_PAGE" ||
    refererRoute.origin !== actionRoute.origin ||
    typeof formBody !== "string" ||
    formBody.length === 0 ||
    formBody.length > 100_000
  ) {
    throw changed();
  }
  assertExactEfirmaFormBody(formBody);
}

/**
 * Defense in depth: even an internal caller cannot accidentally post the
 * visible RFC/password/file controls. Only the observed hidden certform is
 * accepted, once per field and in its observed order.
 */
function assertExactEfirmaFormBody(formBody: string): void {
  const form = new URLSearchParams(formBody);
  const names = [...form.keys()];
  const expected = contract.efirmaLogin.hiddenForm.fieldNames;
  if (
    names.length !== expected.length ||
    names.some((name, index) => name !== expected[index]) ||
    expected.some((name) => form.getAll(name).length !== 1)
  ) {
    throw changed();
  }

  for (const [name, value] of Object.entries(
    contract.efirmaLogin.hiddenForm.staticFieldValues,
  )) {
    if (form.get(name) !== value) throw changed();
  }
  for (const name of contract.efirmaLogin.hiddenForm.emptyFieldNames) {
    if (name !== "token" && name !== "fert" && form.get(name) !== "") {
      throw changed();
    }
  }

  const token = form.get("token") ?? "";
  const guid = form.get("guid") ?? "";
  const fert = form.get("fert") ?? "";
  if (
    !validCanonicalBase64(token, 65_536) ||
    !validBase64Uuid(guid) ||
    !/^\d{12}(?:\d{2})?Z$/.test(fert)
  ) {
    throw changed();
  }
}

function redactUnfollowedRedirect(
  rawUrl: string,
  method: SatPilotHttpMethod,
): SatPilotUnfollowedRedirect {
  try {
    const allowed = assertSatPilotRoute(rawUrl, method);
    return Object.freeze({ kind: "ALLOWLISTED_ROUTE", routeId: allowed.id });
  } catch {
    // Mapping an authenticated route requires seeing its shape, but never its
    // transient SAML/SSO values. No request is made to this destination.
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Object.freeze({ kind: "OUTSIDE_ALLOWLIST" });
  }
  const satHostname = url.hostname === "sat.gob.mx" ||
    url.hostname.endsWith(".sat.gob.mx");
  const rawQueryKeys = [...url.searchParams.keys()];
  if (
    !satHostname ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    isIpHostname(url.hostname) ||
    url.pathname.length === 0 ||
    url.pathname.length > 1_024 ||
    rawQueryKeys.length > 32 ||
    rawQueryKeys.some((key) => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key))
  ) {
    return Object.freeze({ kind: "OUTSIDE_ALLOWLIST" });
  }
  const pathClass = url.origin === "https://wwwmat.sat.gob.mx" &&
      url.pathname === "/nesp/idff/sso"
    ? "MAT_SSO_ASSERTION_CONSUMER"
    : "UNMAPPED";
  const knownQueryKeys = new Set(["RelayState", "SAMLart"]);
  const queryKeyClasses = [...new Set(rawQueryKeys.map((key) =>
    knownQueryKeys.has(key) ? key as "RelayState" | "SAMLart" : "UNMAPPED"
  ))].sort();
  return Object.freeze({
    kind: "SAT_ROUTE_UNMAPPED",
    hostClass: url.hostname === "wwwmat.sat.gob.mx"
      ? "WWW_MAT"
      : url.hostname === "login.siat.sat.gob.mx"
        ? "LOGIN_SIAT"
        : "OTHER_SAT",
    pathClass,
    pathSegmentCount: url.pathname.split("/").filter(Boolean).length,
    queryKeyClasses: Object.freeze(queryKeyClasses),
    queryKeyCount: rawQueryKeys.length,
  });
}

function validCanonicalBase64(value: string, maxLength: number): boolean {
  if (
    value.length === 0 ||
    value.length > maxLength ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function validBase64Uuid(value: string): boolean {
  if (!validCanonicalBase64(value, 128)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    Buffer.from(value, "base64").toString("utf8").toLowerCase(),
  );
}

function isIpHostname(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

interface StoredCookie {
  readonly name: string;
  readonly value: string;
  readonly path: string;
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function cookiePathMatches(cookiePath: string, requestPath: string): boolean {
  return requestPath === cookiePath ||
    (requestPath.startsWith(cookiePath) &&
      (cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/"));
}

/**
 * Restore the certificate-key threshold that OpenSSL security level two would
 * normally enforce, and constrain the acknowledged SAT exception to the exact
 * observed 1024-bit finite-field DH exchange.
 */
export function assertSatPilotTlsPeerEvidence(
  evidence: SatPilotTlsPeerEvidence,
): void {
  if (
    !evidence.authorized ||
    evidence.protocol !== "TLSv1.2" ||
    evidence.cipherName !== SAT_PINNED_TLS12_CIPHER ||
    evidence.ephemeralKey?.type !== "DH" ||
    evidence.ephemeralKey.size !== 1_024
  ) {
    throw changed();
  }

  let certificate: SatPilotPeerCertificate | undefined = evidence.certificate;
  const seen = new Set<string>();
  for (let depth = 0; depth < 8; depth += 1) {
    const fingerprint = certificate?.fingerprint256 ?? "";
    if (
      !certificate ||
      !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(fingerprint) ||
      seen.has(fingerprint) ||
      !Number.isInteger(certificate.bits) ||
      certificate.bits! < 2_048 ||
      certificate.bits! > 16_384 ||
      typeof certificate.modulus !== "string" ||
      certificate.modulus.length < 512 ||
      certificate.exponent !== "0x10001"
    ) {
      throw changed();
    }
    seen.add(fingerprint);

    const issuer: SatPilotPeerCertificate | undefined =
      certificate.issuerCertificate;
    if (
      !issuer ||
      issuer === certificate ||
      issuer.fingerprint256 === fingerprint
    ) {
      return;
    }
    certificate = issuer;
  }
  throw changed();
}

function tlsPeerEvidence(socket: TLSSocket): SatPilotTlsPeerEvidence {
  return {
    authorized: socket.authorized,
    protocol: socket.getProtocol(),
    cipherName: socket.getCipher()?.name,
    ephemeralKey: socket.getEphemeralKeyInfo(),
    certificate: socket.getPeerCertificate(true),
  };
}

/**
 * Node's default TLS policy rejects the observed SAT hosts' legacy 1024-bit
 * DHE parameters. SAT currently negotiates one TLS 1.2 AES-256-GCM/SHA-384
 * suite. Pin exactly that suite and protocol for the two allowlisted hosts.
 * SECLEVEL=1 has effects beyond DH sizing, so compensate with an exact DH-size
 * check and an RSA-2048-or-stronger peer-chain check while retaining CA and
 * hostname verification. Never fall back to the broader SECLEVEL=1 cipher set.
 */
function satPilotNodeFetch(urlValue: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlValue);
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
      reject(new SatReadError("PORTAL_CONTRACT_CHANGED", OPERATION));
      return;
    }

    const outgoingHeaders = Object.fromEntries(new Headers(init.headers).entries());
    const needsSatCompatibility = LEGACY_TLS_HOSTNAMES.has(url.hostname);
    const tlsAgent = needsSatCompatibility ? new SatPilotTlsAgent() : null;
    let settled = false;
    let incoming: import("node:http").IncomingMessage | null = null;
    const cleanup = () => {
      init.signal?.removeEventListener("abort", abort);
      tlsAgent?.destroy();
    };
    const request = httpsRequest(url, {
      // The custom one-shot agent withholds the socket until TLS evidence has
      // passed, preventing headers or a signed body from reaching SAT first.
      agent: tlsAgent ?? false,
      method: init.method ?? "GET",
      headers: outgoingHeaders,
      rejectUnauthorized: true,
      servername: url.hostname,
      minVersion: "TLSv1.2",
      maxVersion: needsSatCompatibility ? "TLSv1.2" : undefined,
      ciphers: needsSatCompatibility
        ? SAT_PINNED_TLS12_CIPHER_CONFIG
        : undefined,
    }, (response) => {
      incoming = response;
      response.once("end", cleanup);
      response.once("close", cleanup);
      const responseHeaders = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        responseHeaders.append(
          response.rawHeaders[index],
          response.rawHeaders[index + 1],
        );
      }
      const noBody = response.statusCode === 204 || response.statusCode === 304;
      const responseBody = noBody
        ? null
        : Readable.toWeb(response) as ReadableStream<Uint8Array>;
      settled = true;
      resolve(new Response(responseBody, {
        status: response.statusCode ?? 500,
        statusText: response.statusMessage,
        headers: responseHeaders,
      }));
    });

    const abort = () => {
      const error = new DOMException("The operation was aborted", "AbortError");
      incoming?.destroy(error);
      request.destroy(error);
    };
    if (init.signal?.aborted) {
      abort();
    } else {
      init.signal?.addEventListener("abort", abort, { once: true });
    }
    request.once("error", (error) => {
      cleanup();
      if (!settled) reject(error);
    });
    if (typeof init.body === "string") request.write(init.body);
    request.end();
  });
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw changed();
    }
    chunks.push(value);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function redirectMethod(status: number, current: SatPilotHttpMethod): SatPilotHttpMethod {
  return status === 303 || ((status === 301 || status === 302) && current === "POST")
    ? "GET"
    : current;
}

function resolveRedirect(location: string, currentUrl: string): string {
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    throw changed();
  }
}

function assertSuccessfulStatus(status: number): void {
  if (status === 429) throw new SatReadError("RATE_LIMITED", OPERATION);
  if (status >= 500) throw new SatReadError("PORTAL_UNAVAILABLE", OPERATION);
  if (status < 200 || status >= 300) throw changed();
}

function normalizedContentType(value: string | null): string {
  return (value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Number.isInteger(value) && value! >= min && value! <= max ? value! : fallback;
}

function changed(): SatReadError {
  return new SatReadError("PORTAL_CONTRACT_CHANGED", OPERATION);
}
