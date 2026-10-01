import type { AgentToolParam } from "openai/resources/beta/agents/agents";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { tools } from "@/lib/ai/tools";
import { toolsPresentacion } from "@/lib/copiloto/tarjetas";
import { objectiveTools } from "./objectives/tools";

// Closed catalogue: adding a tool to the old chat does not silently grant it to
// background agents. Financial writes still use the existing confirmation UI.
export const CAPABILITIES = {
  consultar_objetivos: "read",
  query_saldos_cuentas: "read",
  query_auxiliar_cuenta: "read",
  asignar_objetivo_cierre: "memory",
  query_invoices: "read",
  query_bank_transactions: "read",
  query_tax_declarations: "read",
  query_dashboard_kpis: "read",
  query_customers: "read",
  query_obligations: "read",
  list_unmatched_transactions: "read",
  get_invoice_detail: "read",
  query_cancelaciones: "read",
  query_ppd_cartera: "read",
  query_sat_sync_status: "read",
  query_tax_position: "read",
  query_declaracion_checklist: "read",
  query_complementos_pendientes: "read",
  query_complementos_recibidos_pendientes: "read",
  categorize_transaction: "read",
  suggest_reconciliation_match: "read",
  analyze_anomalies: "read",
  search_fiscal_knowledge: "read",
  get_articulo: "read",
  get_valor_fiscal: "read",
  search_jurisprudencia: "read",
  get_tesis: "read",
  query_cierre_estado: "read",
  query_cierre_paso: "read",
  query_cuentas_sin_agrupador: "read",
  consultar_expediente: "read",
  consultar_solicitudes: "read",
  registrar_hecho: "memory",
  anotar_expediente: "memory",
  cerrar_pendiente: "memory",
  solicitar_al_cliente: "memory",
  proponer_conciliacion: "proposal",
  proponer_crear_subcuenta: "proposal",
  proponer_renombrar_cuenta: "proposal",
  proponer_registro_prestamo: "proposal",
  proponer_categorizacion: "proposal",
  proponer_categorizacion_lote: "proposal",
  mostrar_tarjeta: "presentation",
  ofrecer_acciones: "presentation",
} as const;

export type CapabilityName = keyof typeof CAPABILITIES;
export function capabilityKind(name: string) {
  return Object.hasOwn(CAPABILITIES, name) ? CAPABILITIES[name as CapabilityName] : null;
}
export function allowedCapability(name: string, canWrite: boolean): boolean {
  const kind = capabilityKind(name);
  return kind !== null && (canWrite || kind === "read" || kind === "presentation");
}

const definitions = new Map([...tools, ...toolsPresentacion, ...objectiveTools].map((t) => [t.name, t]));

function schemaFor(name: string) {
  const definition = definitions.get(name);
  if (!definition) throw new Error(`Missing ContaBot capability: ${name}`);
  return { ...definition.input_schema, additionalProperties: false };
}

export function managedTools(canWrite: boolean): AgentToolParam[] {
  return [
    {
      type: "function", name: "consultar_capacidades",
      description: "Consulta qué puede hacer ContaBot y qué requiere confirmación o está fuera de este piloto.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    ...Object.keys(CAPABILITIES).filter((name) => allowedCapability(name, canWrite)).map((name) => ({
      type: "function" as const, name,
      description: definitions.get(name)!.description ?? name,
      parameters: schemaFor(name),
    })),
  ];
}

export function capabilityCatalogue(canWrite: boolean) {
  return {
    capabilities: Object.entries(CAPABILITIES).map(([name, effect]) => ({
      name, effect, availability: allowedCapability(name, canWrite) ? "available" : "unauthorized",
      ...(effect === "proposal" ? { execution: "requires_user_confirmation" } : {}),
    })),
    not_exposed: ["SAT submissions", "e.firma/CSD secrets", "payments", "payroll writes", "code changes", "operator MCP", "cross-company queries"],
    note: "Available means callable. Fiscal support, source coverage and missing data are checked by each service; it does not certify a close.",
  };
}

const validators = new Map<string, ReturnType<typeof fromJsonSchema<Record<string, unknown>>>>();
export async function validateToolInput(name: string, input: unknown): Promise<Record<string, unknown>> {
  if (name === "consultar_capacidades") {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw new Error("INVALID_ARGUMENTS");
    return {};
  }
  if (!capabilityKind(name)) throw new Error("TOOL_NOT_AVAILABLE");
  let validator = validators.get(name);
  if (!validator) {
    validator = fromJsonSchema<Record<string, unknown>>(schemaFor(name) as Parameters<typeof fromJsonSchema>[0]);
    validators.set(name, validator);
  }
  const result = await validator["~standard"].validate(input);
  if (result.issues) throw new Error("INVALID_ARGUMENTS");
  const value = result.value;
  // Bound result fan-out even where older tool schemas have no maximum.
  if (typeof value.limit === "number" && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100)) {
    throw new Error("INVALID_LIMIT: use an integer between 1 and 100");
  }
  return value;
}
