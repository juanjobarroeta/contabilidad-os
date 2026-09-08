import {
  withSatNativePilotSigner,
  type SatNativeCredentialBrokerOptions,
  type SatNativePilotSigner,
} from "./credential-broker";
import {
  SatReadError,
  satReadSuccess,
  toSatReadFailure,
  type SatReadResult,
} from "./errors";
import {
  buildSatNativeCeLoginSubmission,
  openSatNativeCeEfirmaForm,
} from "./preflight";
import {
  SatPilotTransport,
  type SatPilotUnfollowedRedirect,
} from "./transport";

const OPERATION = "LIST_ELECTRONIC_ACCOUNTING" as const;

export interface SatNativeCeLoginProbeObservation {
  readonly state: "FIRST_REDIRECT_OBSERVED";
  readonly surface: "BUZON_TRIBUTARIO_CE";
  readonly credentialUsed: true;
  /** A redirect alone is never accepted as proof of authentication. */
  readonly authenticated: false;
  readonly observedAt: string;
  readonly httpStatus: 301 | 302 | 303 | 307 | 308;
  readonly redirect: SatPilotUnfollowedRedirect;
}

type SignerBoundary = <T>(
  use: (signer: SatNativePilotSigner) => Promise<T>,
  options?: SatNativeCredentialBrokerOptions,
) => Promise<T>;

export interface SatNativeCeLoginProbeOptions {
  /** Always disposed after the probe, including injected test transports. */
  readonly transport?: SatPilotTransport;
  readonly credentialBrokerOptions?: SatNativeCredentialBrokerOptions;
  readonly signerBoundary?: SignerBoundary;
  readonly now?: () => Date;
}

/**
 * Supervised, single-request e.firma probe. It opens the public flow first,
 * acquires the purpose-scoped signer only when the exact form is ready, sends
 * one allowlisted POST, and refuses to follow its redirect. The result contains
 * no RFC, cookie, token, challenge value, response body, or query value.
 */
export async function runSatNativeCeFirstSignedPostProbe(): Promise<
  SatReadResult<SatNativeCeLoginProbeObservation>
> {
  return runSatNativeCeFirstSignedPostProbeInternal({});
}

/** Test-only dependency boundary; the production export accepts no overrides. */
export async function runSatNativeCeFirstSignedPostProbeForTest(
  options: SatNativeCeLoginProbeOptions,
): Promise<SatReadResult<SatNativeCeLoginProbeObservation>> {
  if (process.env.NODE_ENV !== "test") {
    throw new SatReadError("ACCESS_DENIED", OPERATION);
  }
  return runSatNativeCeFirstSignedPostProbeInternal(options);
}

async function runSatNativeCeFirstSignedPostProbeInternal(
  options: SatNativeCeLoginProbeOptions,
): Promise<SatReadResult<SatNativeCeLoginProbeObservation>> {
  const transport = options.transport ?? new SatPilotTransport();
  const signerBoundary = options.signerBoundary ?? withSatNativePilotSigner;
  const now = options.now ?? (() => new Date());

  try {
    const loginDocument = await openSatNativeCeEfirmaForm(transport);
    const observation = await signerBoundary(async (signer) => {
      const submission = buildSatNativeCeLoginSubmission(loginDocument, signer);
      const response = await transport.probeLoginForm(
        submission.actionUrl,
        submission.formBody,
        loginDocument.requestUrl,
      );
      if (looksInteractive(response.body)) {
        throw new SatReadError("NEEDS_USER_ACTION", OPERATION);
      }
      if (!response.unfollowedRedirect) {
        if (/\bid\s*=\s*["']certform["']/i.test(response.body)) {
          throw new SatReadError("AUTH_REJECTED", OPERATION);
        }
        throw new SatReadError("PORTAL_CONTRACT_CHANGED", OPERATION);
      }
      if (response.unfollowedRedirect.kind === "OUTSIDE_ALLOWLIST") {
        throw new SatReadError("PORTAL_CONTRACT_CHANGED", OPERATION);
      }

      const observedAt = now().toISOString();
      if (!Number.isFinite(Date.parse(observedAt))) {
        throw new SatReadError("UNEXPECTED", OPERATION);
      }
      return Object.freeze({
        state: "FIRST_REDIRECT_OBSERVED",
        surface: "BUZON_TRIBUTARIO_CE",
        credentialUsed: true,
        authenticated: false,
        observedAt,
        httpStatus: response.status as 301 | 302 | 303 | 307 | 308,
        redirect: response.unfollowedRedirect,
      } satisfies SatNativeCeLoginProbeObservation);
    }, options.credentialBrokerOptions);

    return satReadSuccess(OPERATION, observation);
  } catch (error) {
    return toSatReadFailure(error, OPERATION);
  } finally {
    transport.dispose();
  }
}

function looksInteractive(html: string): boolean {
  return /\b(?:jcaptchainput|g-recaptcha|grecaptcha|data-sitekey|otp)\b/i.test(
    html,
  );
}
