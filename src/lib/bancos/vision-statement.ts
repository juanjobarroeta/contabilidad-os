import Anthropic from "@anthropic-ai/sdk";
import type { ParsedTransaction } from "@/lib/bank-parser";

// ─────────────────────────────────────────────────────────────────────────────
// Vision extraction of a bank statement from a PDF or image (estado de cuenta).
//
// Used when the user has no CSV/OFX — just a PDF or a photo. We send the file
// to Claude vision and ask for structured movimientos PLUS the opening/closing
// balances, then VALIDATE: opening + Σ movements ≈ closing. If it doesn't
// reconcile we flag it instead of silently importing wrong numbers — financial
// extraction must never be trusted blind.
// ─────────────────────────────────────────────────────────────────────────────

const anthropic = new Anthropic();
const MODEL = "claude-sonnet-4-5";
const BALANCE_TOLERANCE = 1.0; // MXN; rounding slack on the reconciliation check

const SYSTEM_PROMPT = `Eres un experto en estados de cuenta bancarios mexicanos (BBVA, Banamex, Santander, Banorte, HSBC, Scotiabank, etc.). Extrae los movimientos y los saldos en JSON, sin explicaciones.

REGLAS:
1. Devuelve SOLO un objeto JSON válido, nada de markdown.
2. Convención de signo: monto POSITIVO = depósito/abono (entra dinero), NEGATIVO = cargo/retiro (sale dinero).
3. Montos como números sin símbolos ni comas (12345.67, no "$12,345.67").
4. Fechas en formato ISO YYYY-MM-DD. Infiere el año del periodo del estado de cuenta.
5. Extrae TODOS los movimientos, en orden cronológico.
6. Extrae el saldo inicial y el saldo final del periodo tal como aparecen.
7. Si un dato no aparece, usa null. NO inventes.

SCHEMA:
{
  "banco": string | null,
  "numeroCuenta": string | null,
  "periodo": string | null,
  "saldoInicial": number | null,
  "saldoFinal": number | null,
  "movimientos": [
    { "fecha": "YYYY-MM-DD", "descripcion": string, "monto": number, "referencia": string | null, "saldo": number | null }
  ]
}`;

const USER_PROMPT = "Extrae los movimientos y saldos de este estado de cuenta siguiendo el schema exacto. Solo JSON.";

export interface StatementExtraction {
  banco: string | null;
  numeroCuenta: string | null;
  periodo: string | null;
  transactions: ParsedTransaction[];
  balanceCheck: {
    saldoInicial: number | null;
    saldoFinal: number | null;
    sumaMovimientos: number;
    esperadoFinal: number | null;
    cuadra: boolean | null; // null when balances weren't found
    diferencia: number | null;
  };
  warnings: string[];
}

type RawExtraction = {
  banco: string | null;
  numeroCuenta: string | null;
  periodo: string | null;
  saldoInicial: number | null;
  saldoFinal: number | null;
  movimientos: {
    fecha: string;
    descripcion: string;
    monto: number;
    referencia: string | null;
    saldo: number | null;
  }[];
};

/** Extract + validate a bank statement from a PDF/image buffer. */
export async function extractStatementFromDocument(
  buf: Buffer,
  mediaType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp"
): Promise<StatementExtraction> {
  const base64 = buf.toString("base64");
  const docBlock: Anthropic.ContentBlockParam =
    mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: any = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [docBlock, { type: "text", text: USER_PROMPT }],
      },
    ],
  });

  const text =
    response.content.find((b: { type: string }) => b.type === "text")?.text ?? "";
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  let raw: RawExtraction;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    throw new Error("No se pudo leer el estado de cuenta. Intenta con un archivo más claro o el CSV/Excel del banco.");
  }

  const warnings: string[] = [];
  const transactions: ParsedTransaction[] = (raw.movimientos ?? [])
    .filter((m) => m && m.fecha && typeof m.monto === "number")
    .map((m) => {
      const d = new Date(`${m.fecha}T12:00:00`);
      return {
        fecha: d,
        descripcion: (m.descripcion ?? "").trim() || "Movimiento",
        monto: m.monto,
        referencia: m.referencia ?? undefined,
        saldo: typeof m.saldo === "number" ? m.saldo : undefined,
      };
    })
    .filter((t) => !isNaN(t.fecha.getTime()));

  if (transactions.length === 0) {
    warnings.push("No se detectaron movimientos en el documento.");
  }

  // ── Balance reconciliation: saldoInicial + Σ movimientos ≈ saldoFinal ──────
  const sumaMovimientos = round2(transactions.reduce((s, t) => s + t.monto, 0));
  let cuadra: boolean | null = null;
  let esperadoFinal: number | null = null;
  let diferencia: number | null = null;
  if (raw.saldoInicial != null && raw.saldoFinal != null) {
    esperadoFinal = round2(raw.saldoInicial + sumaMovimientos);
    diferencia = round2(esperadoFinal - raw.saldoFinal);
    cuadra = Math.abs(diferencia) <= BALANCE_TOLERANCE;
    if (!cuadra) {
      warnings.push(
        `Los saldos no cuadran: inicial ${fmt(raw.saldoInicial)} + movimientos ${fmt(sumaMovimientos)} = ${fmt(esperadoFinal)}, pero el estado dice ${fmt(raw.saldoFinal)} (diferencia ${fmt(diferencia)}). Revisa antes de importar — pueden faltar o sobrar movimientos.`
      );
    }
  } else {
    warnings.push("No se encontraron saldos inicial/final para validar la extracción. Revisa los movimientos manualmente.");
  }

  return {
    banco: raw.banco ?? null,
    numeroCuenta: raw.numeroCuenta ?? null,
    periodo: raw.periodo ?? null,
    transactions,
    balanceCheck: {
      saldoInicial: raw.saldoInicial ?? null,
      saldoFinal: raw.saldoFinal ?? null,
      sumaMovimientos,
      esperadoFinal,
      cuadra,
      diferencia,
    },
    warnings,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function fmt(n: number): string {
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}
