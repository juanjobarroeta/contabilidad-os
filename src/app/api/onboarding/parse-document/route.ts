import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@/lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/onboarding/parse-document
//
// Unified document parser for the AI onboarding wizard. Accepts a single PDF
// and returns a discriminated union of parsed data depending on which kind
// of SAT/IMSS document Claude detects.
//
// Supported document types:
//   - CSF            → Constancia de Situación Fiscal (SAT)
//   - TARJETA_IMSS   → Tarjeta de Identificación Patronal (IMSS)
//   - ACUSE_ANUAL    → Acuse de declaración anual (SAT)
//   - ACUSE_MENSUAL  → Acuse de pago provisional / definitivo mensual (SAT)
//   - OTRO           → Unknown, returns raw notes for the user
//
// One Claude Vision call classifies AND extracts in the same prompt — cheaper
// and faster than a two-step pipeline.
// ─────────────────────────────────────────────────────────────────────────────

const anthropic = new Anthropic();

const VALID_REGIMENES = new Set([
  "601", "603", "605", "606", "607", "608", "610", "611", "612", "614",
  "615", "616", "620", "621", "622", "623", "624", "625", "626",
]);

const REGIMEN_LABELS: Record<string, string> = {
  "601": "General de Ley Personas Morales",
  "603": "Personas Morales con Fines no Lucrativos",
  "605": "Sueldos y Salarios e Ingresos Asimilados a Salarios",
  "606": "Arrendamiento",
  "607": "Régimen de Enajenación o Adquisición de Bienes",
  "608": "Demás ingresos",
  "610": "Residentes en el Extranjero sin Establecimiento Permanente en México",
  "611": "Ingresos por Dividendos (socios y accionistas)",
  "612": "Personas Físicas con Actividades Empresariales y Profesionales",
  "614": "Ingresos por intereses",
  "615": "Régimen de los ingresos por obtención de premios",
  "616": "Sin obligaciones fiscales",
  "620": "Sociedades Cooperativas de Producción que optan por diferir sus ingresos",
  "621": "Incorporación Fiscal",
  "622": "Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras",
  "623": "Opcional para Grupos de Sociedades",
  "624": "Coordinados",
  "625": "Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas",
  "626": "Régimen Simplificado de Confianza",
};

const SYSTEM_PROMPT = `Eres un asistente experto en documentos fiscales del SAT y del IMSS mexicanos. Tu tarea es CLASIFICAR un documento y EXTRAER sus datos estructurados en una sola pasada.

REGLAS CRÍTICAS:
1. SOLO devuelves un objeto JSON válido. Nada de markdown, nada de explicaciones.
2. Si un campo no aparece, devuelve null. NO inventes valores.
3. Primero determina "type" examinando el encabezado, sellos y estructura del documento:
   - "CSF": Constancia de Situación Fiscal del SAT (dice "Constancia de Situación Fiscal", muestra RFC, régimen fiscal, obligaciones).
   - "TARJETA_IMSS": Tarjeta de Identificación Patronal del IMSS (muestra Registro Patronal, clase, prima, actividad económica IMSS).
   - "ACUSE_ANUAL": Acuse de declaración ANUAL del SAT (dice "Declaración Anual", muestra ejercicio, coeficiente de utilidad, utilidad fiscal, ISR causado).
   - "ACUSE_MENSUAL": Acuse de pago mensual / provisional / definitivo (dice "Pago provisional", "Pago definitivo", "Declaración mensual", muestra periodo mes/año, IVA o ISR).
   - "OTRO": cualquier otro documento.
4. Devuelve los campos correspondientes al type detectado. Los demás quedan como null o arrays vacíos.
5. Fechas en formato ISO YYYY-MM-DD. Montos como números (no strings, sin símbolos).
6. Para CSF: detecta TODOS los regímenes listados, no solo uno. Devuélvelos en "regimenes" como array de { code, label, since }.

SCHEMA DE RESPUESTA (devuelve exactamente estos campos, null cuando no apliquen):
{
  "type": "CSF" | "TARJETA_IMSS" | "ACUSE_ANUAL" | "ACUSE_MENSUAL" | "OTRO",
  "csf": {
    "rfc": string | null,
    "tipoContribuyente": "PF" | "PM" | null,
    "razonSocial": string | null,
    "nombre": string | null,
    "primerApellido": string | null,
    "segundoApellido": string | null,
    "curp": string | null,
    "regimenFiscal": string | null,
    "regimenes": [{ "code": string, "label": string, "since": string | null }],
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
    "obligaciones": string[]
  } | null,
  "imss": {
    "registroPatronal": string | null,
    "razonSocial": string | null,
    "rfc": string | null,
    "clase": string | null,
    "fraccion": string | null,
    "prima": number | null,
    "actividadEconomica": string | null,
    "fechaAlta": string | null
  } | null,
  "acuseAnual": {
    "ejercicio": number | null,
    "rfc": string | null,
    "tipo": "NORMAL" | "COMPLEMENTARIA" | null,
    "ingresosAcumulables": number | null,
    "deduccionesAutorizadas": number | null,
    "utilidadFiscal": number | null,
    "perdidasPendientes": number | null,
    "resultadoFiscal": number | null,
    "isrCausado": number | null,
    "isrAcreditable": number | null,
    "isrAPagar": number | null,
    "isrAFavor": number | null,
    "coeficienteUtilidad": number | null,
    "lineaCaptura": string | null,
    "fechaPresentacion": string | null
  } | null,
  "acuseMensual": {
    "rfc": string | null,
    "periodoMes": number | null,
    "periodoAnio": number | null,
    "tipoImpuesto": "IVA" | "ISR" | "IVA_ISR" | "RETENCIONES" | null,
    "tipoPago": "PROVISIONAL" | "DEFINITIVO" | "NORMAL" | "COMPLEMENTARIA" | null,
    "ivaCausado": number | null,
    "ivaAcreditable": number | null,
    "ivaAPagar": number | null,
    "ivaAFavor": number | null,
    "ivaSaldoFavorAplicado": number | null,
    "isrIngresos": number | null,
    "isrRetenciones": number | null,
    "isrPagosAnteriores": number | null,
    "isrAPagar": number | null,
    "coeficienteUtilidadAplicado": number | null,
    "lineaCaptura": string | null,
    "fechaPresentacion": string | null
  } | null,
  "confidenceNotes": string | null
}`;

const USER_PROMPT = `Clasifica y extrae los datos de este documento siguiendo el schema exacto. Solo JSON.`;

type CsfData = {
  rfc: string | null;
  tipoContribuyente: "PF" | "PM" | null;
  razonSocial: string | null;
  nombre: string | null;
  primerApellido: string | null;
  segundoApellido: string | null;
  curp: string | null;
  regimenFiscal: string | null;
  regimenes: { code: string; label: string; since: string | null }[];
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
};

type ParsedDocument = {
  type: "CSF" | "TARJETA_IMSS" | "ACUSE_ANUAL" | "ACUSE_MENSUAL" | "OTRO";
  csf: CsfData | null;
  imss: Record<string, unknown> | null;
  acuseAnual: Record<string, unknown> | null;
  acuseMensual: Record<string, unknown> | null;
  confidenceNotes: string | null;
};

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

function buildWarnings(doc: ParsedDocument): string[] {
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

  const buf = Buffer.from(await file.arrayBuffer());
  const base64 = buf.toString("base64");

  let responseText = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 3072,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: base64 },
            },
            { type: "text", text: USER_PROMPT },
          ],
        },
      ],
    });
    const block = response.content.find((b: { type: string }) => b.type === "text");
    responseText = block?.text ?? "";
  } catch (e) {
    console.error("[parse-document] Anthropic error:", e);
    return NextResponse.json(
      {
        error: "El asistente IA no pudo procesar el documento. Puedes continuar manualmente con el wizard.",
        detail: e instanceof Error ? e.message : "desconocido",
      },
      { status: 502 }
    );
  }

  const cleaned = responseText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: ParsedDocument;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error("[parse-document] JSON parse error, raw:", cleaned);
    return NextResponse.json(
      {
        error: "La respuesta del asistente no fue un JSON válido.",
        rawResponse: cleaned.slice(0, 500),
        detail: e instanceof Error ? e.message : "parse error",
      },
      { status: 502 }
    );
  }

  // Normalize CSF
  if (parsed.csf) {
    if (parsed.csf.rfc) parsed.csf.rfc = parsed.csf.rfc.trim().toUpperCase();
    if (parsed.csf.curp) parsed.csf.curp = parsed.csf.curp.trim().toUpperCase();
    if (!Array.isArray(parsed.csf.regimenes)) parsed.csf.regimenes = [];
    // Fill in missing labels from our catalog
    parsed.csf.regimenes = parsed.csf.regimenes
      .filter((r) => r && r.code)
      .map((r) => ({
        code: r.code,
        label: r.label || REGIMEN_LABELS[r.code] || r.code,
        since: r.since ?? null,
      }));
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
