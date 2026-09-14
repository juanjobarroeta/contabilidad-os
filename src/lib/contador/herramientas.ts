import type Anthropic from "@anthropic-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// LAS HERRAMIENTAS QUE SÓLO EXISTEN EN LA PASADA (definiciones, sin Prisma).
//
// El copiloto no las lleva: `cerrar_pasada` no tiene sentido en un chat, y
// `leer_salud` / `leer_historia` en una conversación se resuelven preguntando.
// Sumarlas al copiloto sólo agrandaría su prefijo cacheado para nada.
// ─────────────────────────────────────────────────────────────────────────────

export const toolsPasada: Anthropic.Tool[] = [
  {
    name: "leer_salud",
    description:
      "Devuelve la foto de salud de hoy de esta empresa: las nueve dimensiones con su estado, su detalle y sus métricas, más lo que cambió contra la foto anterior. Ya recibes un resumen en tu mensaje; usa esta herramienta cuando necesites las métricas crudas de una dimensión (cuántos días lleva sin sincronizar, cuántos movimientos viejos hay) para no volver a consultarlas por tu cuenta.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "leer_historia",
    description:
      "Devuelve por qué los motores decidieron lo que decidieron sobre una entidad: qué candidatos consideraron, cuál ganó y con qué regla descartaron los demás, mezclado con lo que hicieron las personas. Úsala antes de afirmar que una conciliación está mal: el rastro dice si se aplicó con señal de contraparte o sólo por importe y fecha.",
    input_schema: {
      type: "object",
      properties: {
        entidad: { type: "string", description: "El modelo: BankTransaction, Invoice, FiscalHallazgo…" },
        id: { type: "string", description: "El id de la entidad." },
      },
      required: ["entidad", "id"],
    },
  },
  {
    name: "cerrar_pasada",
    description:
      "Cierra tu pasada con el resumen. Es la ÚNICA salida que se guarda y que alguien va a leer: lo que escribas como texto suelto se descarta. Un renglón por cosa que importa. Si no hay nada que valga la atención de una persona, cierra con sin_novedad y cero renglones — es una respuesta correcta y frecuente, mucho mejor que rellenar con observaciones tibias.",
    input_schema: {
      type: "object",
      properties: {
        sin_novedad: {
          type: "boolean",
          description: "true cuando revisaste y no hay nada que requiera atención. Entonces renglones va vacío.",
        },
        renglones: {
          type: "array",
          items: {
            type: "object",
            properties: {
              estado: {
                type: "string",
                enum: ["atendido", "pendiente", "solicitado", "escalado"],
                description:
                  "atendido = lo dejaste resuelto o propuesto; pendiente = falta trabajo del despacho; solicitado = ya lo pediste al cliente; escalado = necesita que una persona decida.",
              },
              titulo: { type: "string", description: "Qué es, en una línea que se entienda sola." },
              causa: {
                type: "string",
                description:
                  "POR QUÉ está así. Un síntoma no es una causa: «40 movimientos sin conciliar» es síntoma; «no se cargó el estado de cuenta de agosto» es causa. Si no llegaste a la causa, di qué te falta para llegar.",
              },
              accion: { type: "string", description: "Qué hiciste o qué hay que hacer. Concreto y en imperativo." },
              evidencia: {
                type: "array",
                items: { type: "string" },
                description: "Ids que lo respaldan, para que nadie tenga que creerte: movimientos, facturas, hallazgos.",
              },
              fundamento: {
                type: "string",
                description: "El artículo o regla citada, si el renglón afirma algo de la norma.",
              },
            },
            required: ["estado", "titulo", "causa", "accion"],
          },
        },
      },
      required: ["sin_novedad"],
    },
  },
];

export const NOMBRE_CIERRE = "cerrar_pasada";
export const NOMBRES_PASADA = new Set(toolsPasada.map((t) => t.name));
