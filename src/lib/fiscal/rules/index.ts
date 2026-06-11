// Structured fiscal rules layer — public surface.
// Contract: docs/fiscal-brain-contract.md
export * from "./types";
export { CATALOGO } from "./catalog";
export { getRule, listRules } from "./resolve";
export {
  inferSectores,
  inferTipoPersona,
  construirContexto,
  type CompanyLike,
} from "./sector";
