// ─────────────────────────────────────────────────────────────────────────────
// Captura asistida — la ÚNICA puerta al modelo.
//
// Todo lo que el asistente le pide al modelo (estructurar un dictado,
// codificar, armar el egreso) pasa por `llamarModelo`: comprueba los topes de
// IA de la empresa (src/lib/ai/guardia.ts) ANTES de gastar, mide el costo con
// `meteredCreate` (CostEvent por empresa/usuario), exige JSON estricto y, si el
// modelo contesta otra cosa, reintenta UNA vez pidiéndole sólo el objeto. Si el
// modelo configurado no existe para la cuenta (404/403) cae al de respaldo.
//
// Modelo: AI_HOSPITAL_MODEL (default MODELO_LECTOR, Sonnet 5.5); respaldo:
// AI_HOSPITAL_MODEL_FALLBACK (default claude-sonnet-4-6). Al cambiarlos hay
// que dar de alta su tarifa en src/lib/costos/rates.ts.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { asegurarUsoIA } from "@/lib/ai/guardia";
import { meteredCreate } from "@/lib/costos/anthropic";
import { HospitalError } from "../errores";
import { MODELO_LECTOR } from "@/lib/ai/modelos";

export const MODELO_DEFAULT = MODELO_LECTOR;
export const MODELO_RESPALDO_DEFAULT = "claude-sonnet-4-6";
const MAX_TOKENS_DEFAULT = 6000;

export function modeloAsistente(): string {
  return process.env.AI_HOSPITAL_MODEL?.trim() || MODELO_DEFAULT;
}

export function modeloRespaldo(): string {
  return process.env.AI_HOSPITAL_MODEL_FALLBACK?.trim() || MODELO_RESPALDO_DEFAULT;
}

/** El hub sólo habla con el modelo si el servidor tiene la llave (misma regla que parse-csf). */
export function modeloConfigurado(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export const MENSAJE_MODELO_NO_CONFIGURADO = "La captura asistida no está configurada en este servidor (falta la llave del modelo); captura la nota a mano";
export const MENSAJE_RESPUESTA_INVALIDA = "El asistente no devolvió una propuesta válida; inténtalo de nuevo o captura la nota a mano";

export interface LlamadaModelo {
  companyId: string;
  /** Quien disparó la operación: los topes por usuario suman CostEvent con él. */
  userId: string | null;
  /** Etiqueta del CostEvent, p. ej. "hospital.asistente.estructurar". */
  subtipo: string;
  system: string;
  user: string;
  maxTokens?: number;
  /** Modelo principal para esta llamada (default: AI_HOSPITAL_MODEL); el respaldo no cambia. */
  modelo?: string;
  /** Para pruebas y scripts: cliente ya construido. */
  cliente?: Anthropic;
  /**
   * Herramientas de SÓLO LECTURA que el modelo puede pedir antes de contestar
   * el JSON. `ejecutar` decide permisos y nunca debe lanzar por datos del
   * usuario (si lanza, el modelo recibe un error genérico y sigue).
   */
  herramientas?: {
    tools: Anthropic.Tool[];
    ejecutar: (nombre: string, input: unknown) => Promise<unknown>;
    /** Rondas de herramientas antes de obligarlo a contestar (default 4). */
    maxRondas?: number;
  };
}

export interface RespuestaModelo<T> {
  datos: T;
  /** Modelo que contestó (puede ser el de respaldo). */
  modelo: string;
  /** Llamadas hechas al modelo (1 normal, 2 si hubo reintento). */
  intentos: number;
  usage: { inputTokens: number; outputTokens: number };
  /** Herramientas que pidió el modelo, en orden (sólo con `herramientas`). */
  herramientasUsadas?: string[];
}

/** Tope del resultado de una herramienta que se le devuelve al modelo. */
export const MAX_RESULTADO_HERRAMIENTA = 12_000;

function resultadoTexto(r: unknown): string {
  const t = JSON.stringify(r ?? null);
  return t.length > MAX_RESULTADO_HERRAMIENTA ? `${t.slice(0, MAX_RESULTADO_HERRAMIENTA)}… (recortado: pide un filtro más específico)` : t;
}

/**
 * Parseo DEFENSIVO de la salida del modelo: tolera fences y prosa alrededor,
 * pero el resultado debe ser un objeto JSON (no arreglo, no escalar). null si
 * no hay objeto parseable — el llamador decide si reintenta.
 */
export function parsearJsonEstricto(texto: string): Record<string, unknown> | null {
  const limpio = texto
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const inicio = limpio.indexOf("{");
  const fin = limpio.lastIndexOf("}");
  if (inicio < 0 || fin <= inicio) return null;
  try {
    const v: unknown = JSON.parse(limpio.slice(inicio, fin + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function textoDe(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function statusDe(e: unknown): number | undefined {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : undefined;
}

/** Una llamada (no streaming) con cambio al modelo de respaldo si el principal no existe para la cuenta. */
async function crear(
  cliente: Anthropic,
  ctx: { companyId: string; userId: string | null; subtipo: string },
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, "model">,
  principal: string = modeloAsistente()
): Promise<Anthropic.Message> {
  try {
    return await meteredCreate(cliente, ctx, { ...params, model: principal });
  } catch (e) {
    const status = statusDe(e);
    if ((status === 404 || status === 403) && modeloRespaldo() !== principal) {
      return meteredCreate(cliente, ctx, { ...params, model: modeloRespaldo() });
    }
    throw e;
  }
}

function errorProveedor(e: unknown): HospitalError {
  const status = statusDe(e);
  if (status === 429 || status === 529) return new HospitalError(503, "El proveedor del modelo está saturado; inténtalo en un momento o captura la nota a mano");
  const detalle = e instanceof Error ? e.message : String(e);
  console.error("[hospital/asistente] el modelo falló:", detalle);
  return new HospitalError(502, "El asistente no está disponible en este momento; captura la nota a mano");
}

/**
 * Llama al modelo y devuelve el objeto JSON que contestó. Lanza HospitalError:
 * 503 sin llave, 429 por tope de IA de la empresa/usuario, 502 si el modelo
 * no contesta JSON ni al reintentar (o declina), 502/503 si el proveedor falla.
 */
export async function llamarModelo<T extends Record<string, unknown> = Record<string, unknown>>(args: LlamadaModelo): Promise<RespuestaModelo<T>> {
  if (!args.cliente && !modeloConfigurado()) throw new HospitalError(503, MENSAJE_MODELO_NO_CONFIGURADO);

  const guardia = await asegurarUsoIA({ userId: args.userId ?? "", companyId: args.companyId });
  if (!guardia.ok) throw new HospitalError(guardia.status, guardia.mensaje);

  const cliente = args.cliente ?? new Anthropic();
  const ctx = { companyId: args.companyId, userId: args.userId, subtipo: args.subtipo };
  const maxTokens = args.maxTokens ?? MAX_TOKENS_DEFAULT;
  const mensajes: Anthropic.MessageParam[] = [{ role: "user", content: args.user }];
  const usage = { inputTokens: 0, outputTokens: 0 };

  const herr = args.herramientas;
  const maxRondas = herr?.maxRondas ?? 4;
  const usadas: string[] = [];
  let rondas = 0;
  // Con herramientas el system va en bloque con cache_control: las rondas
  // repiten herramientas + guía, y así sólo la primera paga el prefijo completo.
  const system: Anthropic.MessageCreateParamsNonStreaming["system"] = herr
    ? [{ type: "text", text: args.system, cache_control: { type: "ephemeral" } }]
    : args.system;

  for (let intento = 1; intento <= 2; intento++) {
    const pedir = async (): Promise<Anthropic.Message> => {
      try {
        const msg = await crear(cliente, ctx, {
          max_tokens: intento === 1 ? maxTokens : maxTokens * 2,
          system,
          messages: mensajes,
          ...(herr ? { tools: herr.tools, ...(rondas >= maxRondas ? { tool_choice: { type: "none" as const } } : {}) } : {}),
        }, args.modelo);
        usage.inputTokens += msg.usage?.input_tokens ?? 0;
        usage.outputTokens += msg.usage?.output_tokens ?? 0;
        return msg;
      } catch (e) {
        throw errorProveedor(e);
      }
    };
    let msg = await pedir();
    while (herr && msg.stop_reason === "tool_use") {
      rondas++;
      const usos = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const resultados = await Promise.all(
        usos.map(async (u): Promise<Anthropic.ToolResultBlockParam> => {
          usadas.push(u.name);
          try {
            return { type: "tool_result", tool_use_id: u.id, content: resultadoTexto(await herr.ejecutar(u.name, u.input)) };
          } catch (e) {
            console.error(`[hospital/asistente] la herramienta ${u.name} falló:`, e instanceof Error ? e.message : e);
            return { type: "tool_result", tool_use_id: u.id, content: "No se pudo consultar en este momento.", is_error: true };
          }
        })
      );
      mensajes.push({ role: "assistant", content: msg.content }, { role: "user", content: resultados });
      msg = await pedir();
    }
    if (msg.stop_reason === "refusal") throw new HospitalError(502, "El modelo declinó procesar este texto; captura la nota a mano");

    const texto = textoDe(msg);
    const datos = parsearJsonEstricto(texto);
    if (datos) return { datos: datos as T, modelo: msg.model, intentos: intento, usage, herramientasUsadas: usadas };

    // Reintento único: se le enseña lo que contestó y se le pide sólo el objeto.
    mensajes.push(
      { role: "assistant", content: texto || "(sin contenido)" },
      {
        role: "user",
        content:
          msg.stop_reason === "max_tokens"
            ? "Tu respuesta quedó cortada. Responde de nuevo ÚNICAMENTE con el objeto JSON pedido, más breve en cada sección, sin texto adicional."
            : "Tu respuesta no fue un objeto JSON válido. Responde ÚNICAMENTE con el objeto JSON pedido, sin fences, sin explicaciones ni texto adicional.",
      }
    );
  }
  throw new HospitalError(502, MENSAJE_RESPUESTA_INVALIDA);
}
