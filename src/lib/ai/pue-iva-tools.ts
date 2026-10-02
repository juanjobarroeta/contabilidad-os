import type Anthropic from "@anthropic-ai/sdk";

export const pueIvaTools: Anthropic.Tool[] = [
  {
    name: "query_iva_cobro",
    description:
      "Inspecciona un ingreso PUE y su evidencia real: fechas del CFDI y cobros, impuestos, conceptos, revisión anterior e incidencias. El motor ya asigna automáticamente al mes del cobro cuando la evidencia es suficiente; no propongas un cambio innecesario. Para evidencia paginada sigue next_cursor. Si falta conciliación, busca el banco y usa proponer_conciliacion antes de pedir al usuario datos ya disponibles.",
    input_schema: {
      type: "object",
      properties: {
        invoice_id: { type: "string" },
        cursor: { type: "integer", minimum: 0 },
      },
      required: ["invoice_id"],
    },
  },
  {
    name: "proponer_revision_iva_cobro",
    description:
      "Prepara en el chat una revisión documentada del cobro o tratamiento de un ingreso PUE. Usa expected de query_iva_cobro. No cambia nada hasta Confirmar. Fecha opcional: sólo para un cobro COMPLETO comprobado, nunca inferida de PUE/fecha CFDI. Usa documentos ya disponibles y consulta la ley vigente; pregunta en chat sólo por evidencia que realmente falte. FLUJO_GENERAL confirma el tratamiento y desglose del CFDI (incluida una posible exención); REVISION_ESPECIAL conserva el caso pendiente. Para intereses distingue 15-X/18-A: una clave SAT no basta. No inventes evidencia ni reescribas XML, pólizas o declaraciones. Después de confirmar verifica query_tax_position; no envíes al usuario a otro formulario.",
    input_schema: {
      type: "object",
      properties: {
        invoice_id: { type: "string" },
        expected: { type: "string", minLength: 64, maxLength: 64 },
        tratamiento: {
          type: "string",
          enum: ["FLUJO_GENERAL", "REVISION_ESPECIAL"],
        },
        fecha_cobro: {
          type: ["string", "null"],
          description:
            "YYYY-MM-DD del cobro completo documentado; null para usar evidencia bancaria existente.",
        },
        evidencia: {
          type: ["string", "null"],
          maxLength: 1000,
          description:
            "Referencia verificable al documento/pago o respuesta concreta del usuario; requerida cuando se documenta una fecha.",
        },
        motivo: {
          type: "string",
          minLength: 15,
          maxLength: 2000,
          description:
            "Fundamento y hechos que sustentan el tratamiento; se muestran en la tarjeta y guardan en auditoría.",
        },
      },
      required: ["invoice_id", "expected", "tratamiento", "motivo"],
    },
  },
];
export const PUE_IVA_TOOL_NAMES = new Set(pueIvaTools.map((t) => t.name));
