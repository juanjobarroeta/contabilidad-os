import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  parseSatDocument,
  VALID_REGIMENES,
  REGIMEN_LABELS,
  type ParsedSatDocument,
} from "@/lib/fiscal/acuse/parse";

// Node runtime is required to parse a binary multipart body (req.formData with a
// PDF file) reliably on the deployment — matching the other upload routes
// (facturas/upload-cfdi, bancos/upload-pdf). Without it the request can be
// rejected with "espera multipart/form-data". maxDuration covers the AI parse.
export const runtime = "nodejs";
export const maxDuration = 120;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/onboarding/parse-document
//
// Unified document parser for the AI onboarding wizard. Accepts a single PDF
// and returns a discriminated union of parsed data (CSF / TARJETA_IMSS /
// ACUSE_ANUAL / ACUSE_MENSUAL / OTRO). The classify+extract core lives in
// @/lib/fiscal/acuse/parse (shared with the declaraciones backfill); this route
// adds upload handling and CSF normalization/warnings for the wizard.
// ─────────────────────────────────────────────────────────────────────────────

// Normalize a régimen string for fuzzy name matching: lowercase, strip
// accents, drop the "Régimen de…" scaffolding and punctuation.
function normalizeRegimen(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/r[eé]?gimen|de los|de las|\bdel\b|\bde\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const REGIMEN_BY_NAME = Object.entries(REGIMEN_LABELS).map(([code, label]) => ({
  code,
  norm: normalizeRegimen(label),
}));

/**
 * Recover the real 3-digit régimen code. The CSF prints régimenes by name, so
 * the model sometimes returns a wrong code or puts the name in the code field.
 * Trust a valid numeric code if present; otherwise match the printed name
 * against our catalog (longest containment match wins).
 */
function resolveRegimenCode(
  code: string | null | undefined,
  label: string | null | undefined
): string | null {
  const c = (code ?? "").trim();
  if (VALID_REGIMENES.has(c)) return c;
  const hay = normalizeRegimen(label || code || "");
  if (!hay) return null;
  let best: { code: string; score: number } | null = null;
  for (const r of REGIMEN_BY_NAME) {
    if (!r.norm) continue;
    if (hay === r.norm || hay.includes(r.norm) || r.norm.includes(hay)) {
      const score = Math.min(hay.length, r.norm.length);
      if (!best || score > best.score) best = { code: r.code, score };
    }
  }
  return best?.code ?? null;
}

function validateRfc(rfc: string | null): { valid: boolean; reason?: string } {
  if (!rfc) return { valid: false, reason: "RFC no encontrado" };
  const clean = rfc.trim().toUpperCase();
  const pmRe = /^[A-Z&Ñ]{3}[0-9]{6}[A-Z0-9]{3}$/;
  const pfRe = /^[A-Z&Ñ]{4}[0-9]{6}[A-Z0-9]{3}$/;
  if (!pmRe.test(clean) && !pfRe.test(clean)) {
    return { valid: false, reason: `RFC con formato inválido: ${clean}` };
  }
  return { valid: true };
}

function buildWarnings(doc: ParsedSatDocument): string[] {
  const w: string[] = [];
  if (doc.type === "CSF" && doc.csf) {
    const c = doc.csf;
    const rfcCheck = validateRfc(c.rfc);
    if (!rfcCheck.valid) w.push(rfcCheck.reason!);
    if (c.codigoPostal && !/^\d{5}$/.test(c.codigoPostal)) {
      w.push(`Código postal debe ser 5 dígitos: ${c.codigoPostal}`);
    }
    if (c.regimenFiscal && !VALID_REGIMENES.has(c.regimenFiscal)) {
      w.push(`Régimen fiscal no reconocido: ${c.regimenFiscal}`);
    }
    if (c.curp && c.curp.length !== 18) {
      w.push(`CURP debe tener 18 caracteres: ${c.curp}`);
    }
    if (c.tipoContribuyente === "PM" && !c.razonSocial) {
      w.push("Persona moral sin razón social");
    }
    if (c.regimenes && c.regimenes.length > 1) {
      w.push(`Se detectaron ${c.regimenes.length} regímenes. Elige el principal para esta empresa.`);
    }
  }
  if (doc.type === "OTRO") {
    w.push("No se pudo clasificar el documento. Revísalo manualmente.");
  }
  return w;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "AI parsing no está configurado en este servidor" },
      { status: 503 }
    );
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "Formato inválido, espera multipart/form-data" }, { status: 400 });
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

  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");

  let parsed: ParsedSatDocument;
  try {
    parsed = await parseSatDocument(base64, { subtipo: "onboarding.parse_document" });
  } catch (e) {
    console.error("[parse-document] parse error:", e);
    return NextResponse.json(
      {
        error: "El asistente IA no pudo procesar el documento. Puedes continuar manualmente con el wizard.",
        detail: e instanceof Error ? e.message : "desconocido",
      },
      { status: 502 }
    );
  }

  // Normalize CSF
  if (parsed.csf) {
    if (parsed.csf.rfc) parsed.csf.rfc = parsed.csf.rfc.trim().toUpperCase();
    if (parsed.csf.curp) parsed.csf.curp = parsed.csf.curp.trim().toUpperCase();
    if (!Array.isArray(parsed.csf.regimenes)) parsed.csf.regimenes = [];
    // Recover the real 3-digit code (the CSF prints names, not codes, so the
    // model can return a wrong/empty code), then fill the label from our
    // catalog. Drop entries we genuinely can't resolve, and de-dupe by code.
    const seen = new Set<string>();
    parsed.csf.regimenes = parsed.csf.regimenes
      .filter((r) => r && (r.code || r.label))
      .map((r) => {
        const code = resolveRegimenCode(r.code, r.label) ?? "";
        return { code, label: REGIMEN_LABELS[code] || r.label || code, since: r.since ?? null };
      })
      .filter((r) => {
        if (!VALID_REGIMENES.has(r.code) || seen.has(r.code)) return false;
        seen.add(r.code);
        return true;
      });

    // Resolve the single "primary" field too. Leave it null when there are
    // several so the user explicitly picks; default it when there's exactly one.
    parsed.csf.regimenFiscal = resolveRegimenCode(parsed.csf.regimenFiscal, null);
    if (!parsed.csf.regimenFiscal && parsed.csf.regimenes.length === 1) {
      parsed.csf.regimenFiscal = parsed.csf.regimenes[0].code;
    }
    if (parsed.csf.tipoContribuyente === "PF" && !parsed.csf.razonSocial) {
      const parts = [parsed.csf.nombre, parsed.csf.primerApellido, parsed.csf.segundoApellido]
        .filter(Boolean)
        .join(" ")
        .trim();
      if (parts) parsed.csf.razonSocial = parts;
    }
  }

  const warnings = buildWarnings(parsed);

  return NextResponse.json({
    ok: parsed.type !== "OTRO",
    type: parsed.type,
    extracted: parsed,
    warnings,
  });
}
