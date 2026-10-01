import type Anthropic from "@anthropic-ai/sdk";
const scope = { bank_account_id: { type: "string" }, year: { type: "integer", minimum: 2000, maximum: 2100 }, month: { type: "integer", minimum: 1, maximum: 12 } };
const required = ["bank_account_id", "year", "month"];
export const bankStatementTools: Anthropic.Tool[] = [
  { name: "query_bank_accounts", description: "Lista las cuentas bancarias de la empresa y sus IDs para recibir documentos y revisar cobertura. No supone que una cuenta sin movimientos esté completa.", input_schema: { type: "object", properties: {} } },
  { name: "query_statement_review", description: "Revisa TODOS los movimientos y documentos de una cuenta/mes: cobertura, verificación vigente, cambios de versión y duplicados candidatos. Los resultados están paginados: sigue nextCursor hasta null antes de afirmar que no hay pendientes. document_id devuelve filas con procedencia y movimientos no cubiertos. Documentos originales se abren con originalUrl. Importes iguales no prueban duplicidad.",
    input_schema: { type: "object", properties: { ...scope, cursor: { type: "integer", minimum: 0 }, document_id: { type: "string" } }, required } },
  { name: "proponer_revision_bancaria", description: "Prepara UNA decisión revisable sobre evidencia ya consultada. LINK enlaza una fila a un movimiento; NEW confirma otro pago real; EXCLUDE descarta una fila mal extraída; REPLACE corrige un movimiento cambiado; KEEP_BOTH conserva dos pagos distintos; MERGE retira una copia con reversión exacta si procede. Conserva fuentes y bloquea enlaces fiscales/periodos cerrados. Requiere razón con evidencia y confirmación humana. No inventes IDs ni elimines por día/importe. Para verificar controles y cobertura completa abre Bancos → Estados, donde el humano revisa el original.",
    input_schema: { type: "object", properties: { ...scope, expected: { type: "string", description: "hash de query_statement_review" },
      resolution: { type: "string", enum: ["LINK", "NEW", "EXCLUDE", "REPLACE", "KEEP_BOTH", "MERGE"] },
      row_id: { type: "string" }, movement_id: { type: "string" }, primary_id: { type: "string" }, secondary_id: { type: "string" },
      reason: { type: "string", minLength: 8, maxLength: 1000 } }, required: [...required, "expected", "resolution", "reason"] } },
  { name: "consultar_cep_movimiento", description: "Consulta el CEP de UN SPEI existente en la empresa usando Tlaloc/Banxico; reutiliza el guardado y evita repetir intentos. Puede consumir una consulta del proveedor. Requiere permiso de escritura para guardar evidencia. Devuelve campos faltantes si no se puede buscar. Un CEP identifica esa transferencia; no prueba cobertura del mes ni sustituye el estado bancario.",
    input_schema: { type: "object", properties: { transaction_id: { type: "string" } }, required: ["transaction_id"] } },
];
export const BANK_STATEMENT_TOOL_NAMES = new Set(bankStatementTools.map((t) => t.name));
