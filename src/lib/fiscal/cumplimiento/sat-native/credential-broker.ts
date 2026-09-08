import { Credential } from "@nodecfdi/credentials/node";
import { Prisma } from "@prisma/client";
import { decryptSecret, isEncrypted } from "@/lib/crypto";
import { MANDATO_EFIRMA } from "@/lib/legal/documentos";
import { prisma } from "@/lib/prisma";
import { SatReadError, type SatReadErrorCode } from "./errors";
import { assertSatPilotLoginAction } from "./routes";

const OPERATION = "LIST_ELECTRONIC_ACCOUNTING" as const;

export const SAT_NATIVE_PILOT_PURPOSE =
  "LIST_ELECTRONIC_ACCOUNTING_METADATA" as const;
export const SAT_NATIVE_PILOT_ACKNOWLEDGEMENT =
  "METADATA_ONLY_READ_ONLY_SAT_1024_BIT_DHE" as const;
export const SAT_NATIVE_PILOT_EXECUTION_SCOPE =
  "FIRST_SIGNED_POST_ONLY" as const;
export const SAT_NATIVE_PILOT_LEASE_MS = 10 * 60 * 1000;
export const SAT_NATIVE_PILOT_SIGNER_WINDOW_MS = 2 * 60 * 1000;

export interface SatNativeCredentialPolicy {
  readonly enabled: boolean;
  readonly authorizedRfc: string | null;
  readonly operatorUserId: string | null;
  readonly runId: string | null;
  readonly acknowledgement: string | null;
  readonly executionScope: string | null;
}

export interface PreparedSatNativeCredential {
  readonly companyId: string;
  readonly rfc: string;
  readonly actorEmail: string | null;
  readonly encryptedCertificate: string;
  readonly encryptedPrivateKey: string;
  readonly encryptedPassword: string;
}

export interface PrepareSatNativeCredentialInput {
  readonly authorizedRfc: string;
  readonly operatorUserId: string;
  readonly runId: string;
  readonly purpose: typeof SAT_NATIVE_PILOT_PURPOSE;
  readonly now: Date;
}

export interface FinishSatNativeCredentialInput {
  readonly companyId: string;
  readonly operatorUserId: string;
  readonly actorEmail: string | null;
  readonly runId: string;
  readonly purpose: typeof SAT_NATIVE_PILOT_PURPOSE;
  readonly outcomeCode: "COMPLETED" | SatReadErrorCode;
  readonly finishedAt: Date;
}

/**
 * Persistence boundary for the broker. `prepare` must validate every database
 * gate, atomically acquire the lease, and durably write the start audit before
 * returning encrypted material. `finish` must compare-and-set the same lease
 * and durably write the terminal audit.
 */
export interface SatNativeCredentialStore {
  prepare(input: PrepareSatNativeCredentialInput): Promise<PreparedSatNativeCredential>;
  finish(input: FinishSatNativeCredentialInput): Promise<void>;
}

export interface SatNativePilotChallenge {
  /** Exact Base64-UUID tokenuuid value read from the session-aware SAT form. */
  readonly tokenUuid: string;
  readonly actionUrl: string;
}

export interface SatNativePilotLoginToken {
  /** Final opaque token expected by SAT's certform. Never log or persist it. */
  readonly token: string;
  /** Certificate not-after value in the ASN.1 time shape expected by fert. */
  readonly fert: string;
}

/**
 * The only credential capability exposed to a pilot adapter. It is active only
 * inside the broker callback, signs once, uses fixed SHA-1 for the observed SAT
 * login contract, and first validates the form action against the SAT allowlist.
 */
export interface SatNativePilotSigner {
  buildValidatedLoginToken(
    challenge: SatNativePilotChallenge,
  ): SatNativePilotLoginToken;
}

interface CredentialLike {
  isFiel(): boolean;
  rfc(): string;
  certificate(): {
    validOn(): boolean;
    validTo(): Date;
    serialNumber(): { hexadecimal(): string };
  };
  sign(value: string, algorithm: "sha1"): string;
}

export interface SatNativeCredentialBrokerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly store?: SatNativeCredentialStore;
  readonly now?: () => Date;
  /** Test seam. Production uses the application envelope decryptor. */
  readonly decrypt?: (stored: string) => string;
  /** Test seam. Production constructs a real @nodecfdi Credential. */
  readonly createCredential?: (
    certificateBinary: string,
    privateKeyBinary: string,
    password: string,
  ) => CredentialLike;
}

/** Read only by the worker process. No HTTP request can select the target. */
export function satNativeCredentialPolicyFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SatNativeCredentialPolicy {
  return {
    enabled: env.SAT_NATIVE_PILOT_ENABLED === "true",
    authorizedRfc: trimmedOrNull(env.SAT_NATIVE_PILOT_RFC)?.toUpperCase() ?? null,
    operatorUserId: trimmedOrNull(env.SAT_NATIVE_PILOT_OPERATOR_USER_ID),
    runId: trimmedOrNull(env.SAT_NATIVE_PILOT_RUN_ID)?.toLowerCase() ?? null,
    acknowledgement: trimmedOrNull(env.SAT_NATIVE_PILOT_ACKNOWLEDGEMENT),
    executionScope: trimmedOrNull(env.SAT_NATIVE_PILOT_EXECUTION_SCOPE),
  };
}

export async function withSatNativePilotSigner<T>(
  use: (signer: SatNativePilotSigner) => Promise<T>,
): Promise<T> {
  return withSatNativePilotSignerInternal(use, {});
}

/** Test-only dependency boundary; the production export accepts no overrides. */
export async function withSatNativePilotSignerForTest<T>(
  use: (signer: SatNativePilotSigner) => Promise<T>,
  options: SatNativeCredentialBrokerOptions,
): Promise<T> {
  assertTestRuntime();
  return withSatNativePilotSignerInternal(use, options);
}

/**
 * Acquire a single-use, purpose-scoped FIEL signer. Encrypted credentials never
 * leave this function. Expected errors are converted to the safe SAT taxonomy,
 * so upstream exception messages cannot leak credential or portal material.
 */
async function withSatNativePilotSignerInternal<T>(
  use: (signer: SatNativePilotSigner) => Promise<T>,
  options: SatNativeCredentialBrokerOptions,
): Promise<T> {
  const policy = requirePolicy(
    satNativeCredentialPolicyFromEnvironment(options.env),
  );
  const store = options.store ?? prismaSatNativeCredentialStore;
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  let prepared: PreparedSatNativeCredential;
  try {
    prepared = await store.prepare({
      authorizedRfc: policy.authorizedRfc,
      operatorUserId: policy.operatorUserId,
      runId: policy.runId,
      purpose: SAT_NATIVE_PILOT_PURPOSE,
      now: startedAt,
    });
  } catch (error) {
    throw safeSatError(error);
  }

  // Defense in depth: the DB store checks this before acquiring/auditing, and
  // the broker checks it again before invoking any decryptor.
  if (
    normalizeRfc(prepared.rfc) !== policy.authorizedRfc ||
    !isEncrypted(prepared.encryptedCertificate) ||
    !isEncrypted(prepared.encryptedPrivateKey) ||
    !isEncrypted(prepared.encryptedPassword)
  ) {
    const code =
      normalizeRfc(prepared.rfc) === policy.authorizedRfc
        ? "CREDENTIALS_UNAVAILABLE"
        : "ACCESS_DENIED";
    try {
      await finishAfterPrepare(store, prepared, policy, code, now());
    } catch {
      throw new SatReadError("UNEXPECTED", OPERATION);
    }
    throw new SatReadError(code, OPERATION);
  }

  const decrypt = options.decrypt ?? decryptSecret;
  const createCredential = options.createCredential ??
    ((certificate, privateKey, password) =>
      Credential.create(certificate, privateKey, password));

  let certificatePlain = "";
  let privateKeyPlain = "";
  let passwordPlain = "";
  let certificateBytes: Buffer | null = null;
  let privateKeyBytes: Buffer | null = null;
  let credential: CredentialLike | null = null;
  let signerActive = true;
  let signerUsed = false;
  let result: T | undefined;
  let failure: SatReadError | null = null;
  let outcomeCode: FinishSatNativeCredentialInput["outcomeCode"] = "UNEXPECTED";

  try {
    certificatePlain = decrypt(prepared.encryptedCertificate);
    privateKeyPlain = decrypt(prepared.encryptedPrivateKey);
    passwordPlain = decrypt(prepared.encryptedPassword);
    certificateBytes = decodeBase64Strict(certificatePlain);
    privateKeyBytes = decodeBase64Strict(privateKeyPlain);

    try {
      credential = createCredential(
        certificateBytes.toString("binary"),
        privateKeyBytes.toString("binary"),
        passwordPlain,
      );
    } catch {
      throw new SatReadError("CREDENTIALS_UNAVAILABLE", OPERATION);
    }

    if (normalizeRfc(credential.rfc()) !== normalizeRfc(prepared.rfc)) {
      throw new SatReadError("ACCESS_DENIED", OPERATION);
    }
    if (!credential.isFiel()) {
      throw new SatReadError("CREDENTIALS_UNAVAILABLE", OPERATION);
    }
    const certificate = credential.certificate();
    if (!certificate.validOn()) {
      throw new SatReadError("EFIRMA_EXPIRED", OPERATION);
    }

    const portalSerial = portalSerialFromCertificateHex(
      certificate.serialNumber().hexadecimal(),
    );
    const fert = formatAsn1Time(certificate.validTo());
    if (!portalSerial || !fert) {
      throw new SatReadError("CREDENTIALS_UNAVAILABLE", OPERATION);
    }

    const signDeadline = startedAt.getTime() + SAT_NATIVE_PILOT_SIGNER_WINDOW_MS;
    const signer: SatNativePilotSigner = Object.freeze({
      buildValidatedLoginToken(
        challenge: SatNativePilotChallenge,
      ): SatNativePilotLoginToken {
        const activeCredential = credential;
        if (
          !signerActive ||
          signerUsed ||
          !activeCredential ||
          now().getTime() > signDeadline
        ) {
          throw new SatReadError("ACCESS_DENIED", OPERATION);
        }
        assertSatPilotLoginAction(challenge.actionUrl);
        if (!validBase64Uuid(challenge.tokenUuid)) {
          throw new SatReadError("PORTAL_CONTRACT_CHANGED", OPERATION);
        }

        // Consume before signing: even a provider error cannot make this signer
        // reusable for a second challenge.
        signerUsed = true;
        const rfc = normalizeRfc(activeCredential.rfc());
        const signedChallenge =
          challenge.tokenUuid + "|" + rfc + "|" + portalSerial;
        const signatureBinary = activeCredential.sign(signedChallenge, "sha1");
        if (
          typeof signatureBinary !== "string" ||
          signatureBinary.length === 0 ||
          signatureBinary.length > 8_192 ||
          /[^\u0000-\u00FF]/.test(signatureBinary)
        ) {
          throw new SatReadError("CREDENTIALS_UNAVAILABLE", OPERATION);
        }
        const signatureBytes = Buffer.from(signatureBinary, "binary");
        try {
          const signatureBase64 = signatureBytes.toString("base64");
          const challengeBase64 = Buffer.from(signedChallenge, "utf8")
            .toString("base64");
          const wrappedSignatureBase64 = Buffer.from(signatureBase64, "utf8")
            .toString("base64");
          const token = Buffer.from(
            challengeBase64 + "#" + wrappedSignatureBase64,
            "utf8",
          ).toString("base64");
          return Object.freeze({
            token,
            fert,
          });
        } finally {
          signatureBytes.fill(0);
        }
      },
    });

    result = await use(signer);
    outcomeCode = "COMPLETED";
  } catch (error) {
    failure = safeSatError(error);
    outcomeCode = failure.code;
  } finally {
    signerActive = false;
    // Break the escaped signer's reference to the private-key-bearing object.
    credential = null;
    certificateBytes?.fill(0);
    privateKeyBytes?.fill(0);
    certificatePlain = "";
    privateKeyPlain = "";
    passwordPlain = "";

    try {
      await finishAfterPrepare(store, prepared, policy, outcomeCode, now());
    } catch {
      failure = new SatReadError("UNEXPECTED", OPERATION);
    }
  }

  if (failure) throw failure;
  return result as T;
}

export const prismaSatNativeCredentialStore: SatNativeCredentialStore = {
  async prepare(input) {
    return prisma.$transaction(async (tx) => {
      const [operator, company] = await Promise.all([
        tx.user.findUnique({
          where: { id: input.operatorUserId },
          select: { id: true, email: true, esOperador: true },
        }),
        tx.company.findUnique({
          where: { rfc: input.authorizedRfc },
          select: {
            id: true,
            rfc: true,
            isActive: true,
            fielCer: true,
            fielKey: true,
            fielPassword: true,
            fielVigencia: true,
          },
        }),
      ]);

      if (!operator?.esOperador || !company?.isActive) {
        throw new SatReadError("ACCESS_DENIED", OPERATION);
      }

      const mandate = await tx.legalAcceptance.findFirst({
        where: {
          companyId: company.id,
          documento: "MANDATO_EFIRMA",
          version: MANDATO_EFIRMA.version,
        },
        select: { id: true },
      });
      if (!mandate) throw new SatReadError("ACCESS_DENIED", OPERATION);

      if (
        !company.fielCer ||
        !company.fielKey ||
        !company.fielPassword ||
        !isEncrypted(company.fielCer) ||
        !isEncrypted(company.fielKey) ||
        !isEncrypted(company.fielPassword)
      ) {
        throw new SatReadError("CREDENTIALS_UNAVAILABLE", OPERATION);
      }
      if (company.fielVigencia && company.fielVigencia <= input.now) {
        throw new SatReadError("EFIRMA_EXPIRED", OPERATION);
      }

      const existingLeases = await tx.$queryRaw<Array<{
        runId: string;
        operatorUserId: string;
        purpose: string;
        status: string;
        expiresAt: Date;
        databaseNow: Date;
        expired: boolean;
      }>>(Prisma.sql`
        SELECT
          "runId",
          "operatorUserId",
          "purpose",
          "status",
          "expiresAt",
          CURRENT_TIMESTAMP AS "databaseNow",
          "expiresAt" <= CURRENT_TIMESTAMP AS "expired"
        FROM "SatNativePilotLease"
        WHERE "companyId" = ${company.id}
        FOR UPDATE
      `);
      if (existingLeases.length > 1) {
        throw new SatReadError("UNEXPECTED", OPERATION);
      }

      const existingLease = existingLeases[0];
      if (existingLease?.status === "RUNNING" && !existingLease.expired) {
        throw new SatReadError("RUN_IN_PROGRESS", OPERATION);
      }

      if (existingLease?.status === "RUNNING") {
        const expiredRun = await tx.satNativePilotRun.updateMany({
          where: {
            runId: existingLease.runId,
            companyId: company.id,
            operatorUserId: existingLease.operatorUserId,
            purpose: existingLease.purpose,
            status: "RUNNING",
          },
          data: {
            status: "EXPIRED",
            finishedAt: existingLease.databaseNow,
            outcomeCode: "LEASE_EXPIRED",
          },
        });
        if (expiredRun.count !== 1) {
          throw new SatReadError("UNEXPECTED", OPERATION);
        }

        const previousOperator = existingLease.operatorUserId === operator.id
          ? operator
          : await tx.user.findUnique({
              where: { id: existingLease.operatorUserId },
              select: { id: true, email: true },
            });
        await tx.auditLog.create({
          data: {
            companyId: company.id,
            userId: existingLease.operatorUserId,
            actorEmail: previousOperator?.email ?? null,
            accion: "sat-native.fiel-use-expired",
            entidad: "Company",
            entidadId: company.id,
            detalle: {
              runId: existingLease.runId,
              purpose: existingLease.purpose,
              outcomeCode: "LEASE_EXPIRED",
              replacementRunId: input.runId,
            },
          },
        });
      }

      const acquired = await tx.$queryRaw<Array<{ companyId: string }>>(Prisma.sql`
        INSERT INTO "SatNativePilotLease" (
          "companyId", "runId", "operatorUserId", "purpose",
          "acknowledgement", "executionScope", "status",
          "acquiredAt", "expiresAt", "releasedAt", "outcomeCode", "updatedAt"
        ) VALUES (
          ${company.id}, ${input.runId}, ${input.operatorUserId}, ${input.purpose},
          ${SAT_NATIVE_PILOT_ACKNOWLEDGEMENT}, ${SAT_NATIVE_PILOT_EXECUTION_SCOPE},
          'RUNNING', CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP + (${SAT_NATIVE_PILOT_LEASE_MS} * INTERVAL '1 millisecond'),
          NULL, NULL, CURRENT_TIMESTAMP
        )
        ON CONFLICT ("companyId") DO UPDATE SET
          "runId" = EXCLUDED."runId",
          "operatorUserId" = EXCLUDED."operatorUserId",
          "purpose" = EXCLUDED."purpose",
          "acknowledgement" = EXCLUDED."acknowledgement",
          "executionScope" = EXCLUDED."executionScope",
          "status" = 'RUNNING',
          "acquiredAt" = CURRENT_TIMESTAMP,
          "expiresAt" = CURRENT_TIMESTAMP + (${SAT_NATIVE_PILOT_LEASE_MS} * INTERVAL '1 millisecond'),
          "releasedAt" = NULL,
          "outcomeCode" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "SatNativePilotLease"."status" <> 'RUNNING'
           OR "SatNativePilotLease"."expiresAt" <= CURRENT_TIMESTAMP
        RETURNING "companyId"
      `);
      if (acquired.length !== 1) {
        throw new SatReadError("RUN_IN_PROGRESS", OPERATION);
      }

      try {
        await tx.satNativePilotRun.create({
          data: {
            runId: input.runId,
            companyId: company.id,
            operatorUserId: operator.id,
            purpose: input.purpose,
            acknowledgement: SAT_NATIVE_PILOT_ACKNOWLEDGEMENT,
            executionScope: SAT_NATIVE_PILOT_EXECUTION_SCOPE,
            status: "RUNNING",
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw new SatReadError("RUN_ID_REUSED", OPERATION);
        }
        throw error;
      }

      await tx.auditLog.create({
        data: {
          companyId: company.id,
          userId: operator.id,
          actorEmail: operator.email,
          accion: "sat-native.fiel-use-started",
          entidad: "Company",
          entidadId: company.id,
          detalle: {
            runId: input.runId,
            purpose: input.purpose,
            mode: "METADATA_ONLY",
            readOnly: true,
            acknowledgement: SAT_NATIVE_PILOT_ACKNOWLEDGEMENT,
            executionScope: SAT_NATIVE_PILOT_EXECUTION_SCOPE,
          },
        },
      });

      return {
        companyId: company.id,
        rfc: company.rfc,
        actorEmail: operator.email,
        encryptedCertificate: company.fielCer,
        encryptedPrivateKey: company.fielKey,
        encryptedPassword: company.fielPassword,
      };
    });
  },

  async finish(input) {
    await prisma.$transaction(async (tx) => {
      const released = await tx.satNativePilotLease.updateMany({
        where: {
          companyId: input.companyId,
          runId: input.runId,
          acknowledgement: SAT_NATIVE_PILOT_ACKNOWLEDGEMENT,
          executionScope: SAT_NATIVE_PILOT_EXECUTION_SCOPE,
          status: "RUNNING",
        },
        data: {
          status: "RELEASED",
          releasedAt: input.finishedAt,
          outcomeCode: input.outcomeCode,
        },
      });
      if (released.count !== 1) {
        throw new SatReadError("UNEXPECTED", OPERATION);
      }

      const finished = await tx.satNativePilotRun.updateMany({
        where: {
          runId: input.runId,
          companyId: input.companyId,
          operatorUserId: input.operatorUserId,
          purpose: input.purpose,
          acknowledgement: SAT_NATIVE_PILOT_ACKNOWLEDGEMENT,
          executionScope: SAT_NATIVE_PILOT_EXECUTION_SCOPE,
          status: "RUNNING",
        },
        data: {
          status: "RELEASED",
          finishedAt: input.finishedAt,
          outcomeCode: input.outcomeCode,
        },
      });
      if (finished.count !== 1) {
        throw new SatReadError("UNEXPECTED", OPERATION);
      }

      await tx.auditLog.create({
        data: {
          companyId: input.companyId,
          userId: input.operatorUserId,
          actorEmail: input.actorEmail,
          accion: "sat-native.fiel-use-finished",
          entidad: "Company",
          entidadId: input.companyId,
          detalle: {
            runId: input.runId,
            purpose: input.purpose,
            outcomeCode: input.outcomeCode,
          },
        },
      });
    });
  },
};

function requirePolicy(policy: SatNativeCredentialPolicy): Readonly<{
  authorizedRfc: string;
  operatorUserId: string;
  runId: string;
}> {
  if (
    policy.enabled !== true ||
    !policy.authorizedRfc ||
    !validRfc(policy.authorizedRfc) ||
    !policy.operatorUserId ||
    policy.operatorUserId.length > 128 ||
    !policy.runId ||
    !validUuid(policy.runId) ||
    policy.acknowledgement !== SAT_NATIVE_PILOT_ACKNOWLEDGEMENT ||
    policy.executionScope !== SAT_NATIVE_PILOT_EXECUTION_SCOPE
  ) {
    throw new SatReadError("NOT_CONFIGURED", OPERATION);
  }
  return {
    authorizedRfc: policy.authorizedRfc,
    operatorUserId: policy.operatorUserId,
    runId: policy.runId,
  };
}

async function finishAfterPrepare(
  store: SatNativeCredentialStore,
  prepared: PreparedSatNativeCredential,
  policy: Readonly<{ operatorUserId: string; runId: string }>,
  outcomeCode: FinishSatNativeCredentialInput["outcomeCode"],
  finishedAt: Date,
): Promise<void> {
  await store.finish({
    companyId: prepared.companyId,
    operatorUserId: policy.operatorUserId,
    actorEmail: prepared.actorEmail,
    runId: policy.runId,
    purpose: SAT_NATIVE_PILOT_PURPOSE,
    outcomeCode,
    finishedAt,
  });
}

function decodeBase64Strict(value: string): Buffer {
  if (
    value.length === 0 ||
    value.length > 1_000_000 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new SatReadError("CREDENTIALS_UNAVAILABLE", OPERATION);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0) {
    throw new SatReadError("CREDENTIALS_UNAVAILABLE", OPERATION);
  }
  return decoded;
}

/**
 * Match SAT's public X509 JavaScript exactly: for every byte in the DER serial
 * hex string, append the second nibble. SAT FIEL serial bytes encode decimal
 * digits as ASCII (for example 0x33 -> "3"). Converting the whole hex value to
 * decimal produces a different value and cannot be used for this login realm.
 */
export function portalSerialFromCertificateHex(hexadecimal: string): string {
  if (typeof hexadecimal !== "string") {
    throw new SatReadError("CREDENTIALS_UNAVAILABLE", OPERATION);
  }
  const normalized = hexadecimal.trim().replace(/^0x/i, "").toUpperCase();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    normalized.length % 2 !== 0 ||
    !/^[0-9A-F]+$/.test(normalized)
  ) {
    throw new SatReadError("CREDENTIALS_UNAVAILABLE", OPERATION);
  }

  let portalSerial = "";
  for (let index = 0; index < normalized.length; index += 2) {
    portalSerial += normalized[index + 1];
  }
  if (!/^[0-9]+$/.test(portalSerial)) {
    throw new SatReadError("CREDENTIALS_UNAVAILABLE", OPERATION);
  }
  return portalSerial;
}

function formatAsn1Time(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new SatReadError("CREDENTIALS_UNAVAILABLE", OPERATION);
  }
  const year = value.getUTCFullYear();
  const prefix = year >= 1950 && year < 2050
    ? String(year).slice(-2)
    : String(year).padStart(4, "0");
  return prefix +
    twoDigits(value.getUTCMonth() + 1) +
    twoDigits(value.getUTCDate()) +
    twoDigits(value.getUTCHours()) +
    twoDigits(value.getUTCMinutes()) +
    twoDigits(value.getUTCSeconds()) +
    "Z";
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function safeSatError(error: unknown): SatReadError {
  return error instanceof SatReadError
    ? error
    : new SatReadError("UNEXPECTED", OPERATION);
}

function normalizeRfc(value: string): string {
  return value.trim().toUpperCase();
}

function validRfc(value: string): boolean {
  return /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(value);
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
}

function validBase64Uuid(value: string): boolean {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value &&
    validUuid(decoded.toString("utf8").toLowerCase());
}

function trimmedOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function assertTestRuntime(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new SatReadError("ACCESS_DENIED", OPERATION);
  }
}
