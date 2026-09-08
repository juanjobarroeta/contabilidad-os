import { SatReadError, toSatReadFailure, type SatReadResult } from "./errors";
import {
  SAT_READ_ONLY_CAPABILITIES,
  type SatDeclarationArtifactReference,
  type SatDeclarationQuery,
  type SatDeclarationRecord,
  type SatDownloadedArtifact,
  type SatElectronicAccountingArtifactReference,
  type SatElectronicAccountingQuery,
  type SatElectronicAccountingRecord,
  type SatReadOnlyCapabilities,
  type SatReadPage,
} from "./types";

/**
 * Native SAT boundary. Its absence of mutation methods is deliberate: filing,
 * cancellation, payment, and other state-changing operations are out of scope.
 */
export interface SatReadOnlyProvider {
  readonly capabilities: SatReadOnlyCapabilities;

  listDeclarations(
    companyId: string,
    query: SatDeclarationQuery,
  ): Promise<SatReadResult<SatReadPage<SatDeclarationRecord>>>;

  downloadDeclarationArtifact(
    companyId: string,
    reference: SatDeclarationArtifactReference,
  ): Promise<
    SatReadResult<SatDownloadedArtifact<SatDeclarationArtifactReference>>
  >;

  listElectronicAccounting(
    companyId: string,
    query: SatElectronicAccountingQuery,
  ): Promise<SatReadResult<SatReadPage<SatElectronicAccountingRecord>>>;

  downloadElectronicAccountingArtifact(
    companyId: string,
    reference: SatElectronicAccountingArtifactReference,
  ): Promise<
    SatReadResult<
      SatDownloadedArtifact<SatElectronicAccountingArtifactReference>
    >
  >;
}

/**
 * Default fail-closed provider for environments without a native SAT adapter.
 * It performs no I/O and never falls back to browser automation or another
 * provider implicitly.
 */
export class SatReadOnlyProviderUnavailable implements SatReadOnlyProvider {
  readonly capabilities = SAT_READ_ONLY_CAPABILITIES;

  async listDeclarations(
    _companyId: string,
    _query: SatDeclarationQuery,
  ): Promise<SatReadResult<SatReadPage<SatDeclarationRecord>>> {
    return toSatReadFailure(
      new SatReadError("NOT_CONFIGURED", "LIST_DECLARATIONS"),
      "LIST_DECLARATIONS",
    );
  }

  async downloadDeclarationArtifact(
    _companyId: string,
    _reference: SatDeclarationArtifactReference,
  ): Promise<
    SatReadResult<SatDownloadedArtifact<SatDeclarationArtifactReference>>
  > {
    return toSatReadFailure(
      new SatReadError("NOT_CONFIGURED", "DOWNLOAD_DECLARATION_ARTIFACT"),
      "DOWNLOAD_DECLARATION_ARTIFACT",
    );
  }

  async listElectronicAccounting(
    _companyId: string,
    _query: SatElectronicAccountingQuery,
  ): Promise<SatReadResult<SatReadPage<SatElectronicAccountingRecord>>> {
    return toSatReadFailure(
      new SatReadError("NOT_CONFIGURED", "LIST_ELECTRONIC_ACCOUNTING"),
      "LIST_ELECTRONIC_ACCOUNTING",
    );
  }

  async downloadElectronicAccountingArtifact(
    _companyId: string,
    _reference: SatElectronicAccountingArtifactReference,
  ): Promise<
    SatReadResult<
      SatDownloadedArtifact<SatElectronicAccountingArtifactReference>
    >
  > {
    return toSatReadFailure(
      new SatReadError(
        "NOT_CONFIGURED",
        "DOWNLOAD_ELECTRONIC_ACCOUNTING_ARTIFACT",
      ),
      "DOWNLOAD_ELECTRONIC_ACCOUNTING_ARTIFACT",
    );
  }
}
