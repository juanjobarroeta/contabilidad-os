import {
  SatReadError,
  satReadSuccess,
  toSatReadFailure,
  type SatReadErrorCode,
  type SatReadResult,
} from "./errors";

export const SAT_NATIVE_PILOT_DEFAULTS = Object.freeze({
  enabled: false,
  authorizedRfc: null,
  operation: "LIST_ELECTRONIC_ACCOUNTING" as const,
  surface: "BUZON_TRIBUTARIO_CE" as const,
  mode: "METADATA_ONLY" as const,
  readOnly: true as const,
  originalSubmittedXml: "UNVERIFIED" as const,
});

export interface SatNativePilotRequest {
  /** Checked against operator policy before an adapter can be called. */
  readonly rfc: string;
}

export interface SatNativePilotPolicy {
  /** Must come from an operator-controlled worker, never the request. */
  readonly enabled: boolean;
  /** Sole authorized pilot RFC; keep it outside source control. */
  readonly authorizedRfc: string | null;
}

/** Read only by the worker process; request data cannot enable the pilot. */
export function satNativePilotPolicyFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SatNativePilotPolicy {
  return {
    enabled: env.SAT_NATIVE_PILOT_ENABLED === "true",
    authorizedRfc: env.SAT_NATIVE_PILOT_RFC?.trim() || null,
  };
}

/**
 * Deliberately credential-free adapter input. The future worker, not this
 * boundary, is responsible for acquiring a purpose-scoped signer after all
 * launch gates have passed. This contract cannot carry a key, password,
 * certificate, cookie, browser context, or arbitrary URL.
 */
export interface SatNativeBuzonPilotAdapter {
  probeElectronicAccounting(input: Readonly<{
    rfc: string;
    operation: typeof SAT_NATIVE_PILOT_DEFAULTS.operation;
    surface: typeof SAT_NATIVE_PILOT_DEFAULTS.surface;
    mode: typeof SAT_NATIVE_PILOT_DEFAULTS.mode;
    readOnly: typeof SAT_NATIVE_PILOT_DEFAULTS.readOnly;
  }>): Promise<SatNativePilotAdapterResult>;
}

/** Metadata that may cross the portal boundary; no documents or portal state. */
export interface SatNativePilotProbeMetadata {
  readonly fetchedAt: string;
  readonly electronicAccountingRecordCount: number;
  readonly receiptArtifactCount: number;
}

export type SatNativePilotAdapterResult =
  | Readonly<{ kind: "COMPLETED"; metadata: SatNativePilotProbeMetadata }>
  | Readonly<{ kind: "INTERACTIVE_CHALLENGE" }>
  | Readonly<{ kind: "FAILURE"; code: SatReadErrorCode }>;

/**
 * Safe output for a pilot observation. It intentionally omits the RFC,
 * folios, status labels, document names, bytes, URLs, cookies, and browser
 * state. Original XML remains unverified until a supervised pilot proves it.
 */
export interface SatNativePilotMetadata {
  readonly surface: typeof SAT_NATIVE_PILOT_DEFAULTS.surface;
  readonly mode: typeof SAT_NATIVE_PILOT_DEFAULTS.mode;
  readonly fetchedAt: string;
  readonly electronicAccountingRecordCount: number;
  readonly receiptArtifactCount: number;
  readonly originalSubmittedXml: typeof SAT_NATIVE_PILOT_DEFAULTS.originalSubmittedXml;
}

/**
 * Hard-gated, metadata-only Buzón CE pilot. It has no default adapter and does
 * no I/O itself. An interactive challenge is always terminal and is never
 * delegated to a CAPTCHA solver or other bypass.
 */
export async function runSatNativeBuzonPilot(
  request: SatNativePilotRequest,
  adapter?: SatNativeBuzonPilotAdapter,
  policy: SatNativePilotPolicy = SAT_NATIVE_PILOT_DEFAULTS,
): Promise<SatReadResult<SatNativePilotMetadata>> {
  const operation = SAT_NATIVE_PILOT_DEFAULTS.operation;

  const authorizedRfc = policy.authorizedRfc ? normalizarRfc(policy.authorizedRfc) : null;
  if (policy.enabled !== true || !authorizedRfc || !rfcValido(authorizedRfc) || !adapter) {
    return toSatReadFailure(
      new SatReadError("NOT_CONFIGURED", operation),
      operation,
    );
  }

  const requestedRfc = normalizarRfc(request.rfc);
  if (requestedRfc !== authorizedRfc) {
    return toSatReadFailure(
      new SatReadError("ACCESS_DENIED", operation),
      operation,
    );
  }

  try {
    const response = await adapter.probeElectronicAccounting({
      rfc: requestedRfc,
      operation,
      surface: SAT_NATIVE_PILOT_DEFAULTS.surface,
      mode: SAT_NATIVE_PILOT_DEFAULTS.mode,
      readOnly: SAT_NATIVE_PILOT_DEFAULTS.readOnly,
    });

    if (response.kind === "INTERACTIVE_CHALLENGE") {
      return toSatReadFailure(
        new SatReadError("NEEDS_USER_ACTION", operation),
        operation,
      );
    }

    if (response.kind === "FAILURE") {
      return toSatReadFailure(new SatReadError(response.code, operation), operation);
    }

    if (!metadataValida(response.metadata)) {
      return toSatReadFailure(
        new SatReadError("ARTIFACT_INVALID", operation),
        operation,
      );
    }

    return satReadSuccess(operation, {
      surface: SAT_NATIVE_PILOT_DEFAULTS.surface,
      mode: SAT_NATIVE_PILOT_DEFAULTS.mode,
      fetchedAt: response.metadata.fetchedAt,
      electronicAccountingRecordCount: response.metadata.electronicAccountingRecordCount,
      receiptArtifactCount: response.metadata.receiptArtifactCount,
      originalSubmittedXml: SAT_NATIVE_PILOT_DEFAULTS.originalSubmittedXml,
    });
  } catch (error) {
    return toSatReadFailure(error, operation);
  }
}

function normalizarRfc(value: string): string {
  return value.trim().toUpperCase();
}

function rfcValido(value: string): boolean {
  return /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(value);
}

function metadataValida(metadata: SatNativePilotProbeMetadata): boolean {
  return (
    Number.isFinite(Date.parse(metadata.fetchedAt)) &&
    esConteo(metadata.electronicAccountingRecordCount) &&
    esConteo(metadata.receiptArtifactCount)
  );
}

function esConteo(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
