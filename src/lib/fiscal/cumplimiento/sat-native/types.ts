/**
 * Normalized, provider-neutral contracts for read-only SAT retrieval.
 *
 * These types intentionally contain no portal URLs, credentials, browser state,
 * persistence identifiers, or mutation operations.
 */

export const SAT_READ_OPERATIONS = [
  "LIST_DECLARATIONS",
  "DOWNLOAD_DECLARATION_ARTIFACT",
  "LIST_ELECTRONIC_ACCOUNTING",
  "DOWNLOAD_ELECTRONIC_ACCOUNTING_ARTIFACT",
] as const;

export type SatReadOperation = (typeof SAT_READ_OPERATIONS)[number];

export type SatArtifactCapabilityState =
  | "SUPPORTED"
  | "UNSUPPORTED"
  | "UNVERIFIED";

export interface SatReadOnlyCapabilities {
  readonly declarations: Readonly<{
    list: true;
    downloadArtifacts: true;
  }>;
  readonly electronicAccounting: Readonly<{
    list: true;
    downloadArtifacts: true;
    /** Must remain unverified until an authorized pilot proves SAT exposes it. */
    originalSubmittedXml: SatArtifactCapabilityState;
  }>;
  readonly mutations: false;
}

export const SAT_READ_ONLY_CAPABILITIES: SatReadOnlyCapabilities =
  Object.freeze({
    declarations: Object.freeze({
      list: true,
      downloadArtifacts: true,
    }),
    electronicAccounting: Object.freeze({
      list: true,
      downloadArtifacts: true,
      originalSubmittedXml: "UNVERIFIED",
    }),
    mutations: false,
  });

export type SatArtifactSource = "DECLARATIONS" | "ELECTRONIC_ACCOUNTING";

export type SatDeclarationArtifactKind =
  | "ACK_RECEIPT"
  | "TRANSCRIPT"
  | "FINANCIAL_STATEMENTS"
  | "OTHER_DECLARATION_DOCUMENT";

export type SatElectronicAccountingArtifactKind =
  /** Acuse or status document; never imply that it contains the submitted XML. */
  | "RECEIPT"
  | "PROCESSING_RECEIPT"
  /** Only valid after the authorized pilot proves Buzón exposes the original payload. */
  | "ORIGINAL_SUBMITTED_XML"
  /** Only valid after the authorized pilot proves Buzón exposes the seal payload. */
  | "DIGITAL_SEAL_XML"
  | "OTHER_ELECTRONIC_ACCOUNTING_DOCUMENT";

interface SatArtifactReferenceBase {
  /** Opaque identifier supplied by the upstream source. */
  readonly remoteId: string;
}

export interface SatDeclarationArtifactReference extends SatArtifactReferenceBase {
  readonly source: "DECLARATIONS";
  readonly kind: SatDeclarationArtifactKind;
}

export interface SatElectronicAccountingArtifactReference extends SatArtifactReferenceBase {
  readonly source: "ELECTRONIC_ACCOUNTING";
  readonly kind: SatElectronicAccountingArtifactKind;
}

export type SatArtifactReference =
  SatDeclarationArtifactReference | SatElectronicAccountingArtifactReference;

interface SatArtifactMetadata {
  readonly filename: string | null;
  readonly mediaType: string | null;
  readonly sizeBytes: number | null;
}

export type SatDeclarationArtifactDescriptor = SatDeclarationArtifactReference &
  SatArtifactMetadata;

export type SatElectronicAccountingArtifactDescriptor =
  SatElectronicAccountingArtifactReference & SatArtifactMetadata;

export type SatArtifactDescriptor =
  SatDeclarationArtifactDescriptor | SatElectronicAccountingArtifactDescriptor;

export interface SatDownloadedArtifact<
  TReference extends SatArtifactReference = SatArtifactReference,
> {
  readonly reference: TReference;
  readonly filename: string | null;
  readonly mediaType: string | null;
  readonly bytes: Uint8Array;
  /** Lowercase SHA-256 hex digest of bytes. */
  readonly sha256: string;
  /** ISO-8601 timestamp assigned by the retrieval provider. */
  readonly fetchedAt: string;
}

export type SatDeclarationPeriodicity =
  "MONTHLY" | "BIMONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL" | "OTHER";

export type SatDeclarationSubmissionKind =
  "NORMAL" | "COMPLEMENTARY" | "UNKNOWN";

export interface SatDeclarationRecord {
  readonly source: "DECLARATIONS";
  /** Stable opaque key from SAT; never a locally generated database id. */
  readonly remoteId: string;
  readonly fiscalYear: number;
  /** SAT period code, retained as text to support monthly and non-monthly returns. */
  readonly periodCode: string;
  readonly periodicity: SatDeclarationPeriodicity;
  readonly submissionKind: SatDeclarationSubmissionKind;
  readonly declarationName: string;
  readonly operationNumber: string | null;
  readonly captureLine: string | null;
  readonly presentedAt: string | null;
  readonly rawPeriodicity: string | null;
  readonly rawSubmissionKind: string | null;
  readonly artifacts: readonly SatDeclarationArtifactDescriptor[];
}

export type SatElectronicAccountingFileType =
  | "CHART_OF_ACCOUNTS"
  | "TRIAL_BALANCE"
  | "JOURNAL_ENTRIES"
  | "ACCOUNT_AUXILIARY"
  | "FOLIO_AUXILIARY"
  | "UNKNOWN";

export type SatElectronicAccountingStatus =
  "RECEIVED" | "PROCESSING" | "ACCEPTED" | "REJECTED" | "UNKNOWN";

export type SatElectronicAccountingSubmissionKind =
  | "NORMAL"
  | "COMPLEMENTARY"
  | "UNKNOWN";

export interface SatElectronicAccountingRecord {
  readonly source: "ELECTRONIC_ACCOUNTING";
  /** Stable opaque key from SAT; never a locally generated database id. */
  readonly remoteId: string;
  readonly fiscalYear: number;
  /** SAT supports special period codes, so this is not constrained to 1-12. */
  readonly periodCode: string;
  readonly fileType: SatElectronicAccountingFileType;
  readonly status: SatElectronicAccountingStatus;
  readonly submissionKind: SatElectronicAccountingSubmissionKind;
  readonly folio: string | null;
  readonly reason: string | null;
  readonly submittedAt: string | null;
  /** Original SAT label retained for auditability when normalization is unknown. */
  readonly rawFileType: string | null;
  readonly rawStatus: string | null;
  readonly rawSubmissionKind: string | null;
  readonly artifacts: readonly SatElectronicAccountingArtifactDescriptor[];
}

export interface SatReadPage<T> {
  /**
   * Items may be empty only after a complete successful query. Uncertain portal
   * responses must be represented by SatReadFailure, never an empty page.
   */
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  /** ISO-8601 timestamp assigned when the page was fetched. */
  readonly fetchedAt: string;
}

export interface SatDeclarationQuery {
  readonly fromFiscalYear: number;
  readonly toFiscalYear: number;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SatElectronicAccountingPeriod {
  readonly fiscalYear: number;
  /** SAT period code, including any special adjustment period. */
  readonly periodCode: string;
}

export interface SatElectronicAccountingQuery {
  readonly from: SatElectronicAccountingPeriod;
  readonly to: SatElectronicAccountingPeriod;
  readonly cursor?: string;
  readonly limit?: number;
}
