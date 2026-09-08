import contract from "./fixtures/ce-login-contract.2026-09-08.json";
import {
  SatReadError,
  satReadSuccess,
  toSatReadFailure,
  type SatReadResult,
} from "./errors";
import type { SatNativePilotSigner } from "./credential-broker";
import {
  assertSatPilotLoginAction,
  assertSatPilotPasswordTransitionAction,
  assertSatPilotRoute,
  satPilotEfirmaLoginUrl,
} from "./routes";
import { SatPilotTransport, type SatPilotHttpDocument } from "./transport";

const OPERATION = "LIST_ELECTRONIC_ACCOUNTING" as const;

export interface SatNativeCePublicPreflight {
  readonly state: "READY_FOR_AUTHORIZATION";
  readonly surface: "BUZON_TRIBUTARIO_CE";
  readonly loginMechanism: "EFIRMA_FILE_FORM";
  readonly contractObservedAt: string;
  readonly checkedAt: string;
  readonly credentialUsed: false;
  readonly authenticated: false;
}

export interface SatNativeCeLoginSubmission {
  readonly actionUrl: string;
  /** Contains an ephemeral SAT authentication token. Never log or persist. */
  readonly formBody: string;
}

export interface SatNativeCePasswordTransition {
  readonly actionUrl: string;
  readonly refererUrl: string;
}

interface ParsedCeEfirmaLoginForm {
  readonly actionUrl: string;
  readonly tokenUuid: string;
  readonly hiddenValues: ReadonlyMap<string, string>;
}

/**
 * Public, credential-free contract check. This may prove that SAT still serves
 * the expected e.firma form, but it must never be described as a successful
 * login. It sends no RFC, certificate, key, password, cookie from another run,
 * signed challenge, or customer data.
 */
export async function runSatNativeCePublicPreflight(
  transport: SatPilotTransport = new SatPilotTransport(),
  now: () => Date = () => new Date(),
): Promise<SatReadResult<SatNativeCePublicPreflight>> {
  try {
    await openSatNativeCeEfirmaForm(transport);
    const checkedAt = now().toISOString();
    if (!Number.isFinite(Date.parse(checkedAt))) {
      throw new SatReadError("UNEXPECTED", OPERATION);
    }
    return satReadSuccess(OPERATION, {
      state: "READY_FOR_AUTHORIZATION",
      surface: "BUZON_TRIBUTARIO_CE",
      loginMechanism: "EFIRMA_FILE_FORM",
      contractObservedAt: contract.observedAt,
      checkedAt,
      credentialUsed: false,
      authenticated: false,
    });
  } catch (error) {
    return toSatReadFailure(error, OPERATION);
  } finally {
    transport.dispose();
  }
}

/** Internal session-aware form opener. Its returned body must never be logged. */
export async function openSatNativeCeEfirmaForm(
  transport: SatPilotTransport,
): Promise<SatPilotHttpDocument> {
  const ssoDocument = await transport.getCeEntry();
  const passwordTransition = parseCeSsoTransitionDocument(ssoDocument);
  const passwordDocument = await transport.postPasswordTransition(
    passwordTransition.actionUrl,
    passwordTransition.refererUrl,
  );
  assertCePasswordLoginDocument(passwordDocument);
  const document = await transport.getEfirmaLogin(passwordDocument.requestUrl);
  assertCeEfirmaLoginDocument(document);
  return document;
}

/** Parse SAT's one empty auto-submit form; no password or CAPTCHA is posted. */
export function parseCeSsoTransitionDocument(
  document: SatPilotHttpDocument,
): SatNativeCePasswordTransition {
  if (document.routeId !== "CE_SSO_INIT_PAGE" || document.status !== 200) {
    throw changed();
  }
  const refererRoute = assertSatPilotRoute(document.requestUrl, "GET");
  if (refererRoute.id !== "CE_SSO_INIT_PAGE") throw changed();
  const forms = [
    ...document.body.matchAll(/(<form\b[^>]*>)([\s\S]*?)<\/form\s*>/gi),
  ];
  if (forms.length !== 1) throw changed();
  const method = (attribute(forms[0][1], "method") ?? "get").toLowerCase();
  const action = attribute(forms[0][1], "action");
  if (method !== "post" || action === null) throw changed();
  if (/<(?:input|button|textarea|select)\b/i.test(forms[0][2])) throw changed();
  if (!/document\.forms\s*\[\s*0\s*\]\.submit\s*\(\s*\)/.test(document.body)) {
    throw changed();
  }
  let actionUrl: string;
  try {
    actionUrl = new URL(
      decodeHtmlAttribute(action),
      contract.ssoInitiation.origin,
    ).href;
  } catch {
    throw changed();
  }
  assertSatPilotPasswordTransitionAction(actionUrl);
  return Object.freeze({ actionUrl, refererUrl: document.requestUrl });
}

/** Confirm that CE exposes its fixed e.firma transition; never use the CAPTCHA form. */
export function assertCePasswordLoginDocument(
  document: SatPilotHttpDocument,
): void {
  if (document.routeId !== "CE_PASSWORD_LOGIN_PAGE" || document.status !== 200) {
    throw changed();
  }
  const controls = [
    ...document.body.matchAll(/<(?:button|input)\b[^>]*>/gi),
  ].filter(
    (match) =>
      attribute(match[0], "id") ===
      contract.passwordLogin.efirmaTransitionControlId,
  );
  if (controls.length !== 1) throw changed();
  const type = (attribute(controls[0][0], "type") ?? "submit").toLowerCase();
  if (type !== "button") throw changed();
}

/** Fail closed when any required e.firma control is absent or duplicated. */
export function assertCeEfirmaLoginDocument(document: SatPilotHttpDocument): void {
  parseCeEfirmaLoginForm(document);
}

/**
 * Recreate only SAT's hidden certform payload. Certificate, private key,
 * password, and visible RFC fields are intentionally never included.
 */
export function buildSatNativeCeLoginSubmission(
  document: SatPilotHttpDocument,
  signer: SatNativePilotSigner,
): SatNativeCeLoginSubmission {
  const parsed = parseCeEfirmaLoginForm(document);
  const loginToken = signer.buildValidatedLoginToken({
    tokenUuid: parsed.tokenUuid,
    actionUrl: parsed.actionUrl,
  });
  if (
    !validBase64(loginToken.token, 65_536) ||
    !/^\d{12}(?:\d{2})?Z$/.test(loginToken.fert)
  ) {
    throw changed();
  }

  const form = new URLSearchParams();
  for (const fieldName of contract.efirmaLogin.hiddenForm.fieldNames) {
    const value = fieldName === "token"
      ? loginToken.token
      : fieldName === "fert"
        ? loginToken.fert
        : parsed.hiddenValues.get(fieldName);
    if (value === undefined) throw changed();
    form.append(fieldName, value);
  }
  const formBody = form.toString();
  if (formBody.length === 0 || formBody.length > 100_000) throw changed();
  return Object.freeze({ actionUrl: parsed.actionUrl, formBody });
}

function parseCeEfirmaLoginForm(
  document: SatPilotHttpDocument,
): ParsedCeEfirmaLoginForm {
  if (document.routeId !== "CE_EFIRMA_LOGIN_PAGE" || document.status !== 200) {
    throw changed();
  }
  assertNoInteractiveChallenge(document.body);

  for (const inputId of contract.efirmaLogin.visibleForm.fileInputIds) {
    // SAT's file controls have ids but deliberately no names: the browser-side
    // signer consumes the files and the certificate/key are not posted.
    assertSingleInput(document.body, {
      expectedId: inputId,
      expectedTypes: new Set(["file"]),
      expectedName: null,
    });
  }
  assertSingleInput(document.body, {
    expectedId: contract.efirmaLogin.visibleForm.passwordInput.id,
    expectedName: contract.efirmaLogin.visibleForm.passwordInput.name,
    expectedTypes: new Set(["password"]),
  });
  assertSingleInput(document.body, {
    expectedId: contract.efirmaLogin.visibleForm.identityInput.id,
    expectedName: contract.efirmaLogin.visibleForm.identityInput.name,
    expectedTypes: new Set(["text"]),
  });
  assertSingleInput(document.body, {
    expectedId: contract.efirmaLogin.visibleForm.submitControl.id,
    expectedName: contract.efirmaLogin.visibleForm.submitControl.name,
    expectedTypes: new Set(["button", "submit"]),
  });

  const hiddenForm = singleFormById(
    document.body,
    contract.efirmaLogin.hiddenForm.id,
  );
  if ((attribute(hiddenForm.tag, "method") ?? "").toLowerCase() !== "post") {
    throw changed();
  }
  const action = attribute(hiddenForm.tag, "action");
  if (contract.efirmaLogin.hiddenForm.actionMode !== "CURRENT_DOCUMENT") {
    throw changed();
  }
  const actionUrl = action === null
    ? satPilotEfirmaLoginUrl()
    : decodeHtmlAttribute(action);
  assertSatPilotLoginAction(actionUrl);
  const challengeTag = assertSingleInput(hiddenForm.body, {
    expectedId: contract.efirmaLogin.hiddenForm.challengeInputId,
    expectedName: null,
    expectedTypes: new Set(["hidden"]),
  });
  const tokenUuid = decodeHtmlAttribute(attribute(challengeTag, "value") ?? "");
  if (
    contract.efirmaLogin.hiddenForm.challengeEncoding !== "BASE64_UUID" ||
    !validBase64Uuid(tokenUuid)
  ) {
    throw changed();
  }

  const namedInputs = [...hiddenForm.body.matchAll(/<input\b[^>]*>/gi)]
    .map((match) => attribute(match[0], "name"))
    .filter((name): name is string => name !== null && name !== "");
  if (
    namedInputs.length !== contract.efirmaLogin.hiddenForm.fieldNames.length ||
    contract.efirmaLogin.hiddenForm.fieldNames.some(
      (expected) => namedInputs.filter((name) => name === expected).length !== 1,
    )
  ) {
    throw changed();
  }

  const hiddenValues = new Map<string, string>();
  for (const fieldName of contract.efirmaLogin.hiddenForm.fieldNames) {
    const tag = assertSingleInput(hiddenForm.body, {
      expectedId: fieldName,
      expectedName: fieldName,
      expectedTypes: new Set(["hidden"]),
    });
    const value = decodeHtmlAttribute(attribute(tag, "value") ?? "");
    if (value.length > 16_384 || /[\u0000-\u001F\u007F]/.test(value)) {
      throw changed();
    }
    hiddenValues.set(fieldName, value);
  }

  for (const [fieldName, expectedValue] of Object.entries(
    contract.efirmaLogin.hiddenForm.staticFieldValues,
  )) {
    if (hiddenValues.get(fieldName) !== expectedValue) throw changed();
  }
  for (const fieldName of contract.efirmaLogin.hiddenForm.emptyFieldNames) {
    if (hiddenValues.get(fieldName) !== "") throw changed();
  }
  if (
    contract.efirmaLogin.hiddenForm.guidValue !== "SAME_AS_CHALLENGE" ||
    hiddenValues.get("guid") !== tokenUuid
  ) {
    throw changed();
  }
  return { actionUrl, tokenUuid, hiddenValues };
}

function assertNoInteractiveChallenge(html: string): void {
  const interactive = [...html.matchAll(/<input\b[^>]*>/gi)].some((match) => {
    const type = (attribute(match[0], "type") ?? "text").toLowerCase();
    if (type === "hidden") return false;
    const identity = `${attribute(match[0], "id") ?? ""} ${
      attribute(match[0], "name") ?? ""
    }`;
    return /captcha|otp|clave.?dinamica/i.test(identity);
  });
  if (interactive || /\bdata-sitekey\s*=/i.test(html)) {
    throw new SatReadError("NEEDS_USER_ACTION", OPERATION);
  }
}

function assertSingleInput(
  html: string,
  expected: Readonly<{
    expectedId?: string;
    expectedName?: string | null;
    expectedTypes: ReadonlySet<string>;
  }>,
): string {
  const matches = [...html.matchAll(/<input\b[^>]*>/gi)].filter((match) => {
    if (
      expected.expectedId !== undefined &&
      attribute(match[0], "id") !== expected.expectedId
    ) {
      return false;
    }
    return expected.expectedName === undefined ||
      attribute(match[0], "name") === expected.expectedName;
  });
  if (matches.length !== 1) throw changed();
  const type = (attribute(matches[0][0], "type") ?? "text").toLowerCase();
  if (!expected.expectedTypes.has(type)) throw changed();
  return matches[0][0];
}

function singleFormById(
  html: string,
  expectedId: string,
): Readonly<{ tag: string; body: string }> {
  const forms = [...html.matchAll(/(<form\b[^>]*>)([\s\S]*?)<\/form\s*>/gi)]
    .filter((match) => attribute(match[1], "id") === expectedId);
  if (forms.length !== 1) throw changed();
  return { tag: forms[0][1], body: forms[0][2] };
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|(amp|quot|apos|lt|gt));/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined, named: string | undefined) => {
      if (decimal) return safeCodePoint(Number.parseInt(decimal, 10));
      if (hexadecimal) return safeCodePoint(Number.parseInt(hexadecimal, 16));
      const names: Record<string, string> = {
        amp: "&",
        quot: '"',
        apos: "'",
        lt: "<",
        gt: ">",
      };
      return names[named!.toLowerCase()] ?? entity;
    },
  );
}

function safeCodePoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) throw changed();
  return String.fromCodePoint(value);
}

function attribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
  const matches = [...tag.matchAll(
    new RegExp(
      "\\s" + escaped + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
      "gi",
    ),
  )];
  if (matches.length > 1) throw changed();
  const match = matches[0];
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function validBase64(value: string, maxLength: number): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function validBase64Uuid(value: string): boolean {
  if (!validBase64(value, 128)) return false;
  const decoded = Buffer.from(value, "base64");
  const uuid = decoded.toString("utf8");
  return decoded.toString("base64") === value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      uuid,
    );
}

function changed(): SatReadError {
  return new SatReadError("PORTAL_CONTRACT_CHANGED", OPERATION);
}
