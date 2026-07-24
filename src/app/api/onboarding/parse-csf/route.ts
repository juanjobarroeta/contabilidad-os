import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { AuthzError, requireUser } from "@/lib/authz";
import { meteredCreate } from "@/lib/costos/anthropic";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/onboarding/parse-csf
//
// Accepts a Constancia de Situación Fiscal (SAT PDF) as multipart upload and
// returns a structured JSON with all the fields our company wizard needs.
// Uses Anthropic's Claude with PDF document support — no OCR or pdf-parse
// middleware needed; Claude ingests the PDF directly.
//
// Typical CSF fields extracted:
//   rfc, tipoContribuyente (PF/PM), razonSocial, nombre (PF only), curp,
//   regimenFiscal (primary), fechaInicioRegimen, codigoPostal, calle,
//   numExterior, numInterior, colonia, municipio, estado, correo, telefono,
//   actividadEconomica, obligaciones[]
//
// Privacy note: the PDF is forwarded to Anthropic's API and processed
// ephemerally. No data is stored there. We should display a short notice in
// the UI that the file is processed by Claude before sending.
// ─────────────────────────────────────────────────────────────────────────────

// Node runtime for reliable binary multipart parsing (req.formData with a PDF),
// matching the other upload routes. Avoids "espera multipart/form-data".
export const runtime = "nodejs";
export const maxDuration = 120;

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

// SAT régimen catalog — subset we support + validation
const VALID_REGIMENES = new Set([
  "601", "603", "605", "606", "607", "608", "610", "611", "612", "614",
  "615", "616", "620", "621", "622", "623", "624", "625", "626",
]);

// Prompt engineered for maximum structured output. Claude is told EXACTLY
// what schema to produce, and to leave fields null rather than guess.
const SYSTEM_PROMPT = `Eres un asistente experto en documentos fiscales del SAT mexicano. Tu tarea es extraer datos estructurados de una Constancia de Situación Fiscal (CSF).

REGLAS CRÍTICAS:
1. SOLO devuelves un objeto JSON válido, sin markdown, sin explicaciones, sin comentarios.
2. Si un campo no aparece claramente en el documento, devuelve null. NO inventes valores.
3. El RFC de persona moral tiene 12 caracteres. El de persona física tiene 13.
4. El código postal es exactamente 5 dígitos.
5. Para régimen fiscal: si hay varios, devuelve el PRINCIPAL (usualmente el primero listado o el marcado como vigente). Devuelve SOLO el código de 3 dígitos ("601", "612", "626", etc.).
6. Para CURP (solo PF): 18 caracteres alfanuméricos.
7. Para tipoContribuyente: "PF" (persona física) o "PM" (persona moral).
8. Obligaciones: lista de strings cortos describiendo cada obligación encontrada (ej. "Declaración mensual de IVA", "Pagos provisionales de ISR", "DIOT", etc.).
9. actividadEconomica: la descripción textual de la actividad principal, sin el código SCIAN.
10. La fecha debe estar en formato ISO YYYY-MM-DD.

SCHEMA DE RESPUESTA (devuelve exactamente estos campos):
{
  "rfc": string | null,
  "tipoContribuyente": "PF" | "PM" | null,
  "razonSocial": string | null,
  "nombre": string | null,
  "primerApellido": string | null,
  "segundoApellido": string | null,
  "curp": string | null,
  "regimenFiscal": string | null,
  "fechaInicioRegimen": string | null,
  "codigoPostal": string | null,
  "calle": string | null,
  "numExterior": string | null,
  "numInterior": string | null,
  "colonia": string | null,
  "municipio": string | null,
  "estado": string | null,
  "correo": string | null,
  "telefono": string | null,
  "actividadEconomica": string | null,
  "obligaciones": string[],
  "confidenceNotes": string | null
}

Usa "confidenceNotes" (en español, 1-2 líneas) si algún campo fue difícil de extraer o si el documento parece cortado/incompleto. Déjalo en null si todo estuvo claro.`;

const USER_PROMPT = `Extrae los datos de esta Constancia de Situación Fiscal siguiendo el schema exacto. Recuerda: solo JSON, sin texto adicional.`;

type ExtractedCsf = {
  rfc: string | null;
  tipoContribuyente: "PF" | "PM" | null;
  razonSocial: string | null;
  nombre: string | null;
  primerApellido: string | null;
  segundoApellido: string | null;
  curp: string | null;
  regimenFiscal: string | null;
  fechaInicioRegimen: string | null;
  codigoPostal: string | null;
  calle: string | null;
  numExterior: string | null;
  numInterior: string | null;
  colonia: string | null;
  municipio: string | null;
  estado: string | null;
  correo: string | null;
  telefono: string | null;
  actividadEconomica: string | null;
  obligaciones: string[];
  confidenceNotes: string | null;
};

function validateRfc(rfc: string | null): { valid: boolean; reason?: string } {
  if (!rfc) return { valid: false, reason: "RFC no encontrado" };
  const clean = rfc.trim().toUpperCase();
  // PM: 12 chars (3 letters + 6 digits + 3 alphanumeric)
  // PF: 13 chars (4 letters + 6 digits + 3 alphanumeric)
  const pmRe = /^[A-Z&Ñ]{3}[0-9]{6}[A-Z0-9]{3}$/;
  const pfRe = /^[A-Z&Ñ]{4}[0-9]{6}[A-Z0-9]{3}$/;
  if (!pmRe.test(clean) && !pfRe.test(clean)) {
    return { valid: false, reason: `RFC con formato inválido: ${clean}` };
  }
  return { valid: true };
}

function buildValidationWarnings(data: ExtractedCsf): string[] {
  const warnings: string[] = [];

  const rfcCheck = validateRfc(data.rfc);
  if (!rfcCheck.valid) warnings.push(rfcCheck.reason!);

  if (data.codigoPostal && !/^\d{5}$/.test(data.codigoPostal)) {
    warnings.push(`Código postal debe ser 5 dígitos: ${data.codigoPostal}`);
  }
  if (data.regimenFiscal && !VALID_REGIMENES.has(data.regimenFiscal)) {
    warnings.push(`Régimen fiscal no reconocido: ${data.regimenFiscal}`);
  }
  if (data.curp && data.curp.length !== 18) {
    warnings.push(`CURP debe tener 18 caracteres: ${data.curp}`);
  }
  if (data.tipoContribuyente === "PM" && !data.razonSocial) {
    warnings.push("Persona moral sin razón social");
  }
  if (data.tipoContribuyente === "PF" && (!data.nombre || !data.primerApellido)) {
    warnings.push("Persona física sin nombre completo");
  }
  return warnings;
}

export async function POST(req: Request) {
  // Bearer-aware: el wizard de onboarding de los satélites sube la CSF con el
  // token de /api/auth/token; la web sigue entrando por cookie (requireUser
  // intenta ambos).
  try {
    await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "AI parsing no está configurado en este servidor" },
      { status: 503 }
    );
  }

  // Accept multipart/form-data with a "file" field (PDF)
  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch (e) {
    const contentType = req.headers.get("content-type") ?? "(sin Content-Type)";
    console.error("[parse-csf] req.formData() falló", { contentType, err: e instanceof Error ? e.message : String(e) });
    return NextResponse.json(
      { error: `No se pudo leer el archivo subido (Content-Type: ${contentType}). Reintenta; si persiste, el PDF pudo exceder el límite del servidor.` },
      { status: 400 }
    );
  }

  if (!file) {
    return NextResponse.json({ error: "Sube un archivo PDF en el campo 'file'" }, { status: 400 });
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "El archivo excede el límite de 10 MB" }, { status: 413 });
  }
  if (!file.type.includes("pdf") && !file.name.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "Solo se aceptan archivos PDF" }, { status: 415 });
  }

  // Read file into base64 for the Anthropic API
  const buf = Buffer.from(await file.arrayBuffer());
  const base64 = buf.toString("base64");

  let responseText = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await meteredCreate(anthropic, { subtipo: "onboarding.parse_csf" }, {
      model: "claude-sonnet-4-5",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: base64,
              },
            },
            {
              type: "text",
              text: USER_PROMPT,
            },
          ],
        },
      ],
    });

    const block = response.content.find((b: { type: string }) => b.type === "text");
    responseText = block?.text ?? "";
  } catch (e) {
    console.error("[parse-csf] Anthropic error:", e);
    return NextResponse.json(
      {
        error: "El asistente IA no pudo procesar el documento. Puedes continuar manualmente con el wizard.",
        detail: e instanceof Error ? e.message : "desconocido",
      },
      { status: 502 }
    );
  }

  // Strip any accidental markdown code fences Claude might have added
  const cleaned = responseText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: ExtractedCsf;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error("[parse-csf] JSON parse error, raw text:", cleaned);
    return NextResponse.json(
      {
        error: "La respuesta del asistente no fue un JSON válido. Continúa con el wizard manual.",
        rawResponse: cleaned.slice(0, 500),
        detail: e instanceof Error ? e.message : "parse error",
      },
      { status: 502 }
    );
  }

  // Normalize: uppercase RFC/CURP, trim strings
  if (parsed.rfc) parsed.rfc = parsed.rfc.trim().toUpperCase();
  if (parsed.curp) parsed.curp = parsed.curp.trim().toUpperCase();

  // Build "razonSocial" for PF if only individual fields were extracted
  if (parsed.tipoContribuyente === "PF" && !parsed.razonSocial) {
    const parts = [parsed.nombre, parsed.primerApellido, parsed.segundoApellido]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (parts) parsed.razonSocial = parts;
  }

  const warnings = buildValidationWarnings(parsed);
  const rfcCheck = validateRfc(parsed.rfc);

  return NextResponse.json({
    ok: rfcCheck.valid,
    extracted: parsed,
    warnings,
    // Helpful hint for the UI — if RFC is invalid we can't create the company
    canProceed: rfcCheck.valid && !!parsed.regimenFiscal && !!parsed.codigoPostal,
  });
}
