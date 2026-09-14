import type Anthropic from "@anthropic-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// LAS HERRAMIENTAS DEL EXPEDIENTE.
//
// Mismo contrato que las del asunto jurídico: el modelo LEE el expediente en el
// system prompt y lo ESCRIBE con éstas. La descripción de cada una es la
// única instrucción que el modelo recibe sobre cuándo usarla, así que dice el
// caso concreto, no la abstracción.
// ─────────────────────────────────────────────────────────────────────────────

export const toolsExpediente: Anthropic.Tool[] = [
  {
    name: "registrar_hecho",
    description:
      "Guarda un HECHO duradero sobre esta empresa: algo que seguirá siendo cierto la semana que viene. Ejemplos: qué terminal tiene y con qué afiliación (terminal.afiliacion), quién lleva el cierre (cierre.responsable), a cuántos días paga un cliente (cliente.plazo_pago), en qué moneda factura un proveedor (proveedor.moneda), cuántas sucursales opera (operacion.sucursales). NO lo uses para algo de un mes ni para un problema que encontraste: eso es una nota. Un hecho no se edita: si cambió, registra el valor nuevo y el anterior se cierra solo conservando su fecha. Lo que una persona verificó a mano NO lo puedes cambiar.",
    input_schema: {
      type: "object",
      properties: {
        clave: {
          type: "string",
          description:
            "Clave estable en minúsculas con punto: familia.atributo. Usa las conocidas cuando apliquen (terminal.afiliacion, terminal.adquirente, banco.cuenta, cliente.plazo_pago, proveedor.moneda, cierre.responsable, contacto.principal, operacion.giro, operacion.sucursales) y si no, invéntala con la misma forma.",
        },
        valor: {
          type: "string",
          description: "El valor del hecho, en una frase corta o un dato. Si son varios datos, sepáralos con «; ».",
        },
        evidencia: {
          type: "array",
          items: { type: "string" },
          description: "Qué lo respalda: ids de movimientos, facturas, decisiones del motor o documentos.",
        },
        confianza: {
          type: "string",
          enum: ["alta", "media", "baja"],
          description: "«alta» sólo si lo viste en un dato duro; «baja» si lo estás infiriendo.",
        },
      },
      required: ["clave", "valor"],
    },
  },
  {
    name: "anotar_expediente",
    description:
      "Escribe en la BITÁCORA de la empresa lo que revisaste, decidiste o dejaste pendiente. Usa tipo «pendiente» para un COMPROMISO que sigue abierto (falta el estado de cuenta de la terminal, falta el acuse de julio): esos se le muestran a la siguiente corrida antes que nada, así que no dejes un pendiente sin decir qué hace falta exactamente y de quién. Usa «decision» cuando el usuario resuelva algo que debe respetarse después («ese movimiento se queda sin CFDI, es una comisión»), y «observacion» para lo que viste y vale recordar. Una nota por llamada.",
    input_schema: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: ["observacion", "decision", "pendiente"] },
        tema: {
          type: "string",
          enum: ["conciliacion", "sat", "cumplimiento", "declaraciones", "ce", "nomina", "general"],
        },
        titulo: { type: "string", description: "Una línea que se entienda sola dentro de seis meses." },
        cuerpo: { type: "string", description: "Qué pasó y por qué importa, en 1–5 frases. Si es un pendiente, di qué falta y de quién." },
        refs: {
          type: "array",
          items: { type: "string" },
          description: "Ids de las entidades involucradas: movimientos, facturas, hallazgos, decisiones del motor.",
        },
      },
      required: ["tipo", "tema", "titulo", "cuerpo"],
    },
  },
  {
    name: "consultar_expediente",
    description:
      "Devuelve el expediente completo desde la base: hechos vigentes, compromisos abiertos y notas recientes. Ya recibes un resumen en tu contexto; usa esta herramienta cuando necesites el detalle completo de una nota, sus referencias, o para comprobar si algo ya está registrado antes de volver a escribirlo.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "cerrar_pendiente",
    description:
      "Marca un COMPROMISO como resuelto. Úsalo sólo cuando compruebes que lo que faltaba ya llegó o dejó de hacer falta, y explica en «porque» qué lo cerró. No cierres un pendiente porque ya no te parezca importante: si sigue faltando, sigue abierto.",
    input_schema: {
      type: "object",
      properties: {
        nota_id: { type: "string", description: "El id del pendiente, como aparece en consultar_expediente." },
        porque: { type: "string", description: "Qué lo resolvió. Queda escrito como una nota enlazada." },
      },
      required: ["nota_id", "porque"],
    },
  },
];

/** Los nombres que este módulo atiende. Para que el ejecutor no los adivine. */
export const NOMBRES_EXPEDIENTE = new Set(toolsExpediente.map((t) => t.name));
