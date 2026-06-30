// ─────────────────────────────────────────────────────────────────────────────
// Fallback LLM para categorizar conceptos bancarios SIN CFDI
//
// Sólo se invoca para los movimientos que el motor de reglas
// (`sugerirCategoriaConcepto`) NO pudo clasificar. Reutiliza el cliente Anthropic
// y el medidor de costo (`meteredCreate` → CostEvent categoría LLM) del resto de
// la app. Está fuertemente acotado:
//   • max_tokens muy bajo (sólo necesitamos una etiqueta de familia),
//   • el modelo DEBE elegir una de las familias conocidas o "NINGUNA",
//   • ante cualquier duda devolvemos null (no adivinamos) → el movimiento queda
//     sin clasificar para revisión manual.
//
// La cuenta SAT y la etiqueta legible se derivan de la familia que devuelve el
// modelo usando la MISMA tabla que el motor de reglas, así nunca inventamos un
// código de cuenta.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { meteredCreate } from "@/lib/costos/anthropic";
import { COE_CODES } from "@/lib/contabilidad/catalog";
import type {
  FamiliaConcepto,
  SignoMovimiento,
  SugerenciaCategoria,
} from "./categorizar-concepto";

const anthropic = new Anthropic(); // ANTHROPIC_API_KEY del entorno
const MODEL = process.env.AI_CHAT_MODEL ?? "claude-fable-5";
const MODEL_FALLBACK = "claude-opus-4-8";
const MAX_TOKENS = 32; // sólo emitimos una palabra (la familia)

// Catálogo de familias que el modelo puede elegir → cuenta + etiqueta. Es la
// misma correspondencia que usa el motor de reglas, por lo que el LLM nunca
// decide el código de cuenta: sólo la familia.
const FAMILIA_A_CUENTA: Record<FamiliaConcepto, { cuenta: string; etiqueta: string }> = {
  COMISION: { cuenta: COE_CODES.COMISIONES_BANCARIAS, etiqueta: "Comisiones bancarias" },
  TAX_PAYMENT: { cuenta: COE_CODES.IMPUESTOS_DERECHOS, etiqueta: "Impuestos y derechos" },
  PAYROLL_NO_CFDI: { cuenta: COE_CODES.SUELDOS_SALARIOS, etiqueta: "Nómina (sueldos y salarios)" },
  INTERNAL_TRANSFER: { cuenta: COE_CODES.BANCOS, etiqueta: "Traspaso entre cuentas propias" },
  FINANCIAL_INCOME: { cuenta: COE_CODES.OTROS_INGRESOS, etiqueta: "Productos financieros (intereses ganados)" },
  RENT: { cuenta: COE_CODES.RENTAS, etiqueta: "Rentas" },
  NON_DEDUCTIBLE: { cuenta: COE_CODES.GASTOS_NO_DEDUCIBLES, etiqueta: "Gasto no deducible" },
};

const FAMILIAS_VALIDAS = Object.keys(FAMILIA_A_CUENTA) as FamiliaConcepto[];

const SYSTEM_PROMPT = `Eres un contador mexicano que clasifica movimientos bancarios SIN factura (CFDI).
Recibes el concepto del movimiento y si entró o salió dinero. Responde con UNA SOLA palabra: la familia contable que mejor corresponda, o NINGUNA si no estás razonablemente seguro.

Familias válidas:
- COMISION: comisión o cargo por servicio bancario.
- TAX_PAYMENT: pago de impuestos, contribuciones o derechos (SAT, ISR, IVA, DPA, predial, tenencia).
- PAYROLL_NO_CFDI: dispersión o pago de nómina, sueldos, salarios o raya.
- INTERNAL_TRANSFER: traspaso o transferencia entre cuentas propias.
- FINANCIAL_INCOME: intereses o rendimientos ganados (solo cuando entra dinero).
- RENT: pago de renta o arrendamiento.
- NON_DEDUCTIBLE: gasto claramente no deducible.

Reglas:
- Si tienes cualquier duda razonable, responde NINGUNA.
- No expliques. Responde solo la palabra.`;

/**
 * Intenta categorizar un concepto bancario con el LLM. Devuelve null si el
 * modelo no está seguro (NINGUNA), si la respuesta no es una familia válida, o
 * si la llamada falla (best-effort: nunca lanza). La confianza siempre es
 * "media" — una sugerencia LLM nunca se marca como alta.
 */
export async function sugerirCategoriaConceptoLLM(
  concepto: string,
  signo: SignoMovimiento,
  ctx: { companyId?: string | null } = {},
): Promise<SugerenciaCategoria | null> {
  if (!concepto || !concepto.trim()) return null;

  const userText = `Concepto: ${concepto.slice(0, 200)}\nMovimiento: ${signo === "CREDITO" ? "entró dinero" : "salió dinero"}`;

  let model = MODEL;
  let response: Anthropic.Message;
  try {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userText }],
    };
    try {
      response = await meteredCreate(anthropic, { companyId: ctx.companyId, subtipo: "bancos.categorizar_concepto" }, params);
    } catch (err) {
      if (model !== MODEL_FALLBACK && err instanceof Anthropic.NotFoundError) {
        model = MODEL_FALLBACK;
        response = await meteredCreate(
          anthropic,
          { companyId: ctx.companyId, subtipo: "bancos.categorizar_concepto" },
          { ...params, model },
        );
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error("[bancos] categorizar-llm falló:", err instanceof Error ? err.message : err);
    return null;
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z_]/g, "");

  if (!text || text === "NINGUNA") return null;

  const familia = FAMILIAS_VALIDAS.find((f) => f === text);
  if (!familia) return null;

  // Coherencia de signo: intereses ganados sólo en entradas.
  if (familia === "FINANCIAL_INCOME" && signo !== "CREDITO") return null;

  const { cuenta, etiqueta } = FAMILIA_A_CUENTA[familia];
  return { familia, cuentaSugerida: cuenta, etiqueta, confianza: "media" };
}
