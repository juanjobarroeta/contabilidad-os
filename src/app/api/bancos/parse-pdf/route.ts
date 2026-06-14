import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@/lib/auth";
import { meteredCreate } from "@/lib/costos/anthropic";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bancos/parse-pdf
//
// AI-powered bank statement PDF parser. Upload any bank's PDF statement
// and Claude extracts all transactions. Works with BBVA, Banamex, Banorte,
// Santander, HSBC, Scotiabank, Bajío — any Mexican bank PDF.
//
// Returns transactions in the same format as the CSV parser so the upload
// endpoint can consume them identically.
// ─────────────────────────────────────────────────────────────────────────────

const anthropic = new Anthropic();

const SYSTEM_PROMPT = `Eres un experto en estados de cuenta bancarios mexicanos. Extrae TODAS las transacciones del estado de cuenta en formato JSON.

REGLAS:
1. SOLO devuelves un JSON válido. Sin markdown, sin explicaciones.
2. Extrae CADA transacción con fecha, descripción, monto y saldo.
3. Los cargos/retiros son NEGATIVOS. Los abonos/depósitos son POSITIVOS.
4. Fechas en formato YYYY-MM-DD.
5. Montos como números (sin $, sin comas). Negativos para cargos.
6. Si hay múltiples páginas, extrae TODAS las transacciones de TODAS las páginas.
7. No omitas ninguna transacción — el conteo debe coincidir con el estado de cuenta.

SCHEMA:
{
  "banco": string,
  "titular": string | null,
  "cuenta": string | null,
  "periodo": { "desde": string, "hasta": string } | null,
  "saldoInicial": number | null,
  "saldoFinal": number | null,
  "transactions": [
    {
      "fecha": "YYYY-MM-DD",
      "descripcion": string,
      "monto": number,
      "saldo": number | null,
      "referencia": string | null
    }
  ]
}`;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "AI no configurado" }, { status: 503 });
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "Formato inválido" }, { status: 400 });
  }

  if (!file) return NextResponse.json({ error: "Sube un archivo PDF" }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "Máximo 20 MB" }, { status: 413 });

  const buf = Buffer.from(await file.arrayBuffer());
  const base64 = buf.toString("base64");

  let responseText = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await meteredCreate(anthropic, { subtipo: "bancos.parse_pdf" }, {
      model: "claude-sonnet-4-5",
      max_tokens: 8192, // Bank statements can be long
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
          { type: "text", text: "Extrae todas las transacciones de este estado de cuenta. JSON only." },
        ],
      }],
    });
    const block = response.content.find((b: { type: string }) => b.type === "text");
    responseText = block?.text ?? "";
  } catch (e) {
    console.error("[parse-pdf] Anthropic error:", e);
    return NextResponse.json(
      { error: "No se pudo procesar el PDF", detail: e instanceof Error ? e.message : "desconocido" },
      { status: 502 }
    );
  }

  const cleaned = responseText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  let parsed: {
    banco: string;
    titular: string | null;
    cuenta: string | null;
    periodo: { desde: string; hasta: string } | null;
    saldoInicial: number | null;
    saldoFinal: number | null;
    transactions: {
      fecha: string;
      descripcion: string;
      monto: number;
      saldo: number | null;
      referencia: string | null;
    }[];
  };

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return NextResponse.json(
      { error: "La respuesta AI no fue JSON válido", raw: cleaned.slice(0, 500) },
      { status: 502 }
    );
  }

  // Validate and clean transactions
  const transactions = (parsed.transactions ?? [])
    .filter(t => t.fecha && t.monto !== 0 && !isNaN(t.monto))
    .map(t => ({
      fecha: t.fecha,
      descripcion: (t.descripcion ?? "").replace(/\s+/g, " ").trim(),
      monto: Math.round(t.monto * 100) / 100,
      saldo: t.saldo != null ? Math.round(t.saldo * 100) / 100 : null,
      referencia: t.referencia?.trim() || null,
    }));

  return NextResponse.json({
    ok: true,
    banco: parsed.banco,
    titular: parsed.titular,
    cuenta: parsed.cuenta,
    periodo: parsed.periodo,
    saldoInicial: parsed.saldoInicial,
    saldoFinal: parsed.saldoFinal,
    transactions,
    count: transactions.length,
  });
}
