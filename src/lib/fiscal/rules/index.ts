// Structured fiscal rules layer — public surface.
// Contract: docs/fiscal-brain-contract.md
export * from "./types";
export { CATALOGO } from "./catalog";
export { getRule, listRules, aplicaAplicabilidad } from "./resolve";
export {
  inferSectores,
  inferTipoPersona,
  estadoDesdeCP,
  construirContexto,
  ENTIDADES,
  esEntidad,
  type CompanyLike,
} from "./sector";
