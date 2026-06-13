export {
  SyntageClient,
  SyntageError,
  type SyntageConfig,
  type Extractor,
  type EstadoCredencial,
  type EstadoExtraccion,
} from "./client";
export { mapTaxCompliance, mapTaxStatus } from "./map";
export {
  SyntageComplianceProvider,
  type EntityResolver,
  type SyntageProviderOpts,
} from "./provider";
export { provisionCompany, provisionAllCompanies, type ProvisionResult } from "./provision";
export { syncCompanyComplianceSyntage, syncAllCompaniesComplianceSyntage, type SyncResult } from "./sync";
