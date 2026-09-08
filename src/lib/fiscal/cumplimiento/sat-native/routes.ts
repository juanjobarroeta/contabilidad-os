import contract from "./fixtures/ce-login-contract.2026-09-08.json";
import { SatReadError } from "./errors";

export type SatPilotHttpMethod = "GET" | "POST";
export type SatPilotRouteId =
  | "CE_ENTRY"
  | "CE_PORTAL_LOGIN_BRIDGE"
  | "CE_SSO_INIT_PAGE"
  | "CE_PASSWORD_LOGIN_PAGE"
  | "CE_EFIRMA_LOGIN_PAGE"
  | "CE_EFIRMA_LOGIN_SUBMIT"
  | "CE_LOGIN_ASSET";

export interface ValidatedSatPilotRoute {
  readonly id: SatPilotRouteId;
  readonly origin: string;
  readonly method: SatPilotHttpMethod;
}

const OPERATION = "LIST_ELECTRONIC_ACCOUNTING" as const;
const ENTRY_URL = `${contract.entry.origin}${contract.entry.pathname}`;
const EFIRMA_LOGIN_URL =
  `${contract.efirmaLogin.origin}${contract.efirmaLogin.pathname}` +
  `?id=${encodeURIComponent(contract.efirmaLogin.id)}` +
  `&sid=${encodeURIComponent(contract.efirmaLogin.sidValues[0])}` +
  `&option=${encodeURIComponent(contract.efirmaLogin.option)}` +
  `&sid=${encodeURIComponent(contract.efirmaLogin.sidValues[1])}`;
const LOGIN_ASSETS = new Set(contract.loginAssetPaths);

export function satPilotEntryUrl(): string {
  return ENTRY_URL;
}

export function satPilotEfirmaLoginUrl(): string {
  return EFIRMA_LOGIN_URL;
}

/**
 * Validate every navigation, redirect, form action, and subresource against the
 * sanitized contract observed from the public CE entry. The return value never
 * includes a URL or query value, so callers cannot accidentally log SAT state.
 */
export function assertSatPilotRoute(
  rawUrl: string,
  method: SatPilotHttpMethod,
): ValidatedSatPilotRoute {
  const url = parseStrictHttpsUrl(rawUrl);

  if (
    method === "GET" &&
    url.origin === contract.entry.origin &&
    url.pathname === contract.entry.pathname &&
    url.search === ""
  ) {
    return { id: "CE_ENTRY", origin: url.origin, method };
  }

  if (
    method === "GET" &&
    url.origin === contract.portalBridge.origin &&
    url.pathname === contract.portalBridge.pathname
  ) {
    validatePortalBridgeQuery(url);
    return { id: "CE_PORTAL_LOGIN_BRIDGE", origin: url.origin, method };
  }

  if (
    method === "GET" &&
    url.origin === contract.ssoInitiation.origin &&
    url.pathname === contract.ssoInitiation.pathname &&
    url.searchParams.has("RequestID")
  ) {
    validateSsoInitiationQuery(url);
    return { id: "CE_SSO_INIT_PAGE", origin: url.origin, method };
  }

  if (
    url.origin === contract.passwordLogin.origin &&
    url.pathname === contract.passwordLogin.pathname &&
    url.searchParams.get("id") === contract.passwordLogin.id
  ) {
    validatePasswordLoginQuery(url);
    return {
      id: "CE_PASSWORD_LOGIN_PAGE",
      origin: url.origin,
      method,
    };
  }

  if (
    url.origin === contract.efirmaLogin.origin &&
    url.pathname === contract.efirmaLogin.pathname &&
    url.searchParams.get("id") === contract.efirmaLogin.id
  ) {
    validateEfirmaLoginQuery(url);
    return {
      id: method === "POST"
        ? "CE_EFIRMA_LOGIN_SUBMIT"
        : "CE_EFIRMA_LOGIN_PAGE",
      origin: url.origin,
      method,
    };
  }

  if (
    method === "GET" &&
    url.origin === contract.efirmaLogin.origin &&
    LOGIN_ASSETS.has(url.pathname) &&
    url.search === ""
  ) {
    return { id: "CE_LOGIN_ASSET", origin: url.origin, method };
  }

  throw contractChanged();
}

export function assertSatPilotLoginAction(rawUrl: string): ValidatedSatPilotRoute {
  const route = assertSatPilotRoute(rawUrl, "POST");
  if (route.id !== "CE_EFIRMA_LOGIN_SUBMIT") throw contractChanged();
  return route;
}

export function assertSatPilotPasswordTransitionAction(
  rawUrl: string,
): ValidatedSatPilotRoute {
  const route = assertSatPilotRoute(rawUrl, "POST");
  if (route.id !== "CE_PASSWORD_LOGIN_PAGE") throw contractChanged();
  return route;
}

function parseStrictHttpsUrl(rawUrl: string): URL {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > 4096) {
    throw contractChanged();
  }

  const rawPath = rawUrl.split(/[?#]/, 1)[0];
  // Every allowlisted path is fixed ASCII. Reject all percent-encoded path
  // bytes so a proxy/server cannot reinterpret a double-encoded separator.
  if (/\\|%/.test(rawPath)) throw contractChanged();

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw contractChanged();
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    url.pathname.includes("//") ||
    isIpLiteral(url.hostname)
  ) {
    throw contractChanged();
  }
  return url;
}

function validatePortalBridgeQuery(url: URL): void {
  assertExactQueryKeys(url, ["agAppNa", "c", "target"]);
  if (
    !singleValueEquals(url, "agAppNa", contract.portalBridge.application) ||
    !singleValueEquals(url, "c", contract.portalBridge.context) ||
    !singleValueEquals(url, "target", `"${ENTRY_URL}"`)
  ) {
    throw contractChanged();
  }
}

function validateSsoInitiationQuery(url: URL): void {
  const expectedKeys = [
    "RequestID",
    "MajorVersion",
    "MinorVersion",
    "IssueInstant",
    "ProviderID",
    "RelayState",
    "consent",
    "agAppNa",
    "ForceAuthn",
    "IsPassive",
    "NameIDPolicy",
    "ProtocolProfile",
    "target",
    "AuthnContextStatementRef",
  ];
  assertExactQueryKeys(url, expectedKeys);
  const requestId = url.searchParams.get("RequestID") ?? "";
  const issueInstant = url.searchParams.get("IssueInstant") ?? "";
  if (
    !/^id[-_A-Za-z0-9]{16,128}$/.test(requestId) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(issueInstant) ||
    !Number.isFinite(Date.parse(issueInstant)) ||
    !singleValueEquals(url, "MajorVersion", "1") ||
    !singleValueEquals(url, "MinorVersion", "2") ||
    !singleValueEquals(url, "ProviderID", contract.ssoInitiation.providerId) ||
    !singleValueEquals(url, "RelayState", "MA==") ||
    !singleValueEquals(url, "consent", "urn:liberty:consent:unavailable") ||
    !singleValueEquals(url, "agAppNa", contract.portalBridge.application) ||
    !singleValueEquals(url, "ForceAuthn", "false") ||
    !singleValueEquals(url, "IsPassive", "false") ||
    !singleValueEquals(url, "NameIDPolicy", "onetime") ||
    !singleValueEquals(
      url,
      "ProtocolProfile",
      contract.ssoInitiation.protocolProfile,
    ) ||
    !singleValueEquals(url, "target", ENTRY_URL) ||
    !singleValueEquals(
      url,
      "AuthnContextStatementRef",
      contract.ssoInitiation.authnContext,
    )
  ) {
    throw contractChanged();
  }
}

function validatePasswordLoginQuery(url: URL): void {
  const allowedKeys = new Set([
    "id",
    "option",
    "sid",
    ...contract.passwordLogin.optionalQueryKeys,
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key)) throw contractChanged();
  }

  if (
    !singleValueEquals(url, "id", contract.passwordLogin.id) ||
    !singleValueEquals(url, "option", contract.passwordLogin.option)
  ) {
    throw contractChanged();
  }

  const sidValues = url.searchParams.getAll("sid");
  if (
    sidValues.length !== contract.passwordLogin.sidValues.length ||
    sidValues.some(
      (value, index) => value !== contract.passwordLogin.sidValues[index],
    )
  ) {
    throw contractChanged();
  }

  const targets = url.searchParams.getAll("target");
  if (targets.length > 1) throw contractChanged();
  if (targets.length === 1 && targets[0] !== ENTRY_URL) throw contractChanged();
}

function assertExactQueryKeys(url: URL, expected: readonly string[]): void {
  const actual = [...url.searchParams.keys()];
  if (
    actual.length !== expected.length ||
    expected.some((key) => actual.filter((value) => value === key).length !== 1)
  ) {
    throw contractChanged();
  }
}

function validateEfirmaLoginQuery(url: URL): void {
  const allowedKeys = new Set([
    "id",
    "option",
    "sid",
    ...contract.efirmaLogin.optionalQueryKeys,
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key)) throw contractChanged();
  }
  if (
    !singleValueEquals(url, "id", contract.efirmaLogin.id) ||
    !singleValueEquals(url, "option", contract.efirmaLogin.option)
  ) {
    throw contractChanged();
  }
  const sidValues = url.searchParams.getAll("sid");
  if (
    sidValues.length !== contract.efirmaLogin.sidValues.length ||
    sidValues.some(
      (value, index) => value !== contract.efirmaLogin.sidValues[index],
    )
  ) {
    throw contractChanged();
  }
}

function singleValueEquals(url: URL, key: string, expected: string): boolean {
  const values = url.searchParams.getAll(key);
  return values.length === 1 && values[0] === expected;
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

function contractChanged(): SatReadError {
  return new SatReadError("PORTAL_CONTRACT_CHANGED", OPERATION);
}
