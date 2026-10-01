import type Anthropic from "@anthropic-ai/sdk";

export const accountingTools: Anthropic.Tool[] = [
  { name: "proponer_crear_subcuenta", description: "Prepara la creación de una subcuenta bajo una cuenta existente del catálogo propio, con su mismo tipo, naturaleza y agrupador SAT oficial. Sin saldo ni pólizas. Primero consulta query_saldos_cuentas para elegir el padre y evitar duplicados. La persona debe confirmar la tarjeta.",
    input_schema: { type: "object", properties: { chart_account_id: { type: "string" }, codigo: { type: "string", maxLength: 80 }, nombre: { type: "string", minLength: 2, maxLength: 150 } }, required: ["chart_account_id", "codigo", "nombre"] } },
  { name: "proponer_renombrar_cuenta", description: "Prepara renombrar una cuenta identificada por query_saldos_cuentas. Conserva código, saldos y movimientos. Usa para dar nombre a un placeholder sólo después de comprobar a quién corresponde; no cambies la identidad de una cuenta con historia por suposición. Muestra nombre anterior y nuevo; requiere confirmación.",
    input_schema: { type: "object", properties: { chart_account_id: { type: "string" }, nombre: { type: "string", minLength: 2, maxLength: 150 } }, required: ["chart_account_id", "nombre"] } },
  { name: "proponer_registro_prestamo", description: "Prepara la póliza de UN movimiento bancario de capital de préstamo contra el auxiliar EXACTO elegido del catálogo propio. Requiere cuenta bancaria ligada a su cuenta contable, movimiento sin aplicar y auxiliar válido de deudores/acreedores. Conserva esa cuenta al regenerar el cierre. LOAN_GIVEN: prestamos o recuperamos; LOAN_RECEIVED: nos prestan o devolvemos. No incluye intereses ni impuesto ni depura duplicados. Consulta saldos/soporte primero; confirma quién debe a quién. El humano confirma la tarjeta antes de registrar.",
    input_schema: { type: "object", properties: { transaction_id: { type: "string" }, chart_account_id: { type: "string" }, familia: { type: "string", enum: ["LOAN_GIVEN", "LOAN_RECEIVED"] } }, required: ["transaction_id", "chart_account_id", "familia"] } },
  { name: "query_saldos_cuentas", description: "Lee el catálogo y saldos reales por cuenta de la empresa: balanza CE importada del periodo, último periodo CE anterior disponible y saldo del ledger local. Busca por nombre de contraparte o códigos. Devuelve fecha, fuente y estado del periodo por separado; una CE no presentada no impide leer el ledger local. No compenses saldos de deudor/acreedor ni asumas que cuenta sin registros tiene saldo cero. No consulta SAT ni genera pólizas.",
    input_schema: { type: "object", properties: {
      year: { type: "integer", minimum: 2000, maximum: 2100 }, month: { type: "integer", minimum: 1, maximum: 12 },
      search: { type: "string", maxLength: 100, description: "Nombre o parte del código de cuenta, por ejemplo The Tranding Margin." },
      cuentas: { type: "array", maxItems: 25, items: { type: "string", maxLength: 80 }, description: "Códigos exactos del catálogo propio, como 1170-008 y 2130-011." },
    }, required: ["year", "month"] } },
  { name: "query_auxiliar_cuenta", description: "Lee las pólizas/movimientos del ledger local de UNA cuenta del periodo. Usa el chart_account_id de query_saldos_cuentas. Indica si la lista está truncada. No significa que el periodo esté completo o presentado al SAT.",
    input_schema: { type: "object", properties: {
      chart_account_id: { type: "string", minLength: 1 }, year: { type: "integer", minimum: 2000, maximum: 2100 },
      month: { type: "integer", minimum: 1, maximum: 12 }, limit: { type: "integer", minimum: 1, maximum: 100 },
    }, required: ["chart_account_id", "year", "month"] } },
];
