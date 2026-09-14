import type Anthropic from "@anthropic-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// LAS HERRAMIENTAS DE SOLICITUDES (sólo definiciones, sin Prisma).
//
// La descripción es la única instrucción que el modelo recibe sobre cuándo
// pedir algo, así que dice lo que de verdad importa: pedir es caro para el
// cliente. Un pedido de más enseña a ignorar los pedidos, y el que sí importaba
// se pierde entre ellos.
// ─────────────────────────────────────────────────────────────────────────────

export const toolsSolicitudes: Anthropic.Tool[] = [
  {
    name: "solicitar_al_cliente",
    description:
      "Abre una SOLICITUD: algo que necesitamos del cliente y que no podemos conseguir solos (un estado de cuenta, un comprobante, una aclaración, una decisión suya). Queda abierta hasta que llegue, se le enseña al usuario junto al movimiento que la provocó y el digest la lleva. Úsala sólo cuando ya comprobaste que el dato NO está en el sistema y que sin él no se puede avanzar — pedir de más enseña al cliente a ignorar los pedidos, y el que sí importaba se pierde entre ellos. Antes de abrir una, consulta_solicitudes para no repetir una que ya está abierta.",
    input_schema: {
      type: "object",
      properties: {
        tipo: {
          type: "string",
          enum: [
            "estado_cuenta_terminal",
            "voucher_terminal",
            "estado_cuenta_banco",
            "comprobante",
            "documento_fiscal",
            "aclaracion",
            "decision",
          ],
        },
        detalle: {
          type: "string",
          description:
            "El detalle de ESTE caso, en una frase: qué movimiento o factura lo motiva y qué se necesita exactamente. El «qué pedir» y el «para qué» genéricos los pone el sistema.",
        },
        periodo: { type: "string", description: "El mes al que corresponde, como YYYY-MM, si aplica." },
        refs: {
          type: "array",
          items: { type: "string" },
          description: "Ids de los movimientos, facturas o hallazgos que la motivan. Sin esto la solicitud no aparece en la mesa junto a lo que la provocó.",
        },
      },
      required: ["tipo", "detalle"],
    },
  },
  {
    name: "consultar_solicitudes",
    description:
      "Devuelve lo que ya se le pidió al cliente y sigue sin llegar. Consúltala ANTES de reportar que falta algo: si ya está pedido, lo útil es decir desde cuándo se espera, no volver a descubrir el hueco.",
    input_schema: { type: "object", properties: {} },
  },
];

export const NOMBRES_SOLICITUDES = new Set(toolsSolicitudes.map((t) => t.name));
