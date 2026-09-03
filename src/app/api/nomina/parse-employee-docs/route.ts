import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@/lib/auth";
import { meteredCreate } from "@/lib/costos/anthropic";
import { asegurarUsoIA, respuestaTopeIA } from "@/lib/ai/guardia";
import { getEffectiveCompanyMembership } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/nomina/parse-employee-docs
//
// AI employee onboarding: accepts 1 PDF (CURP, Constancia NSS, contrato
// laboral, or any combo) and extracts structured employee data.
// Same pattern as /api/onboarding/parse-document.
// ─────────────────────────────────────────────────────────────────────────────

const anthropic = new Anthropic();

const SYSTEM_PROMPT = `Eres un experto en documentos laborales y fiscales mexicanos. Tu tarea es CLASIFICAR un documento de empleado y EXTRAER sus datos estructurados.

REGLAS CRÍTICAS:
1. SOLO devuelves un objeto JSON válido. Nada de markdown, nada de explicaciones.
2. Si un campo no aparece, devuelve null. NO inventes valores.
3. Primero determina "type" examinando el documento:
   - "CURP": Cédula de CURP del RENAPO (muestra CURP de 18 caracteres, nombre, fecha de nacimiento, sexo, entidad).
   - "NSS": Constancia/Tarjeta de NSS del IMSS (muestra Número de Seguridad Social de 11 dígitos, nombre).
   - "CONTRATO": Contrato individual de trabajo (muestra salario, puesto, tipo de contrato, jornada, fecha de ingreso).
   - "ALTA_IMSS": Aviso de Alta o movimiento IMSS (muestra NSS, fecha de alta, salario base cotización).
   - "INE": Credencial INE/IFE (muestra nombre, CURP, fecha nacimiento, domicilio).
   - "RFC_SAT": Constancia RFC del SAT (muestra RFC de 13 caracteres para persona física).
   - "COMPROBANTE_DOMICILIO": Comprobante de domicilio (muestra dirección, CP).
   - "CFDI_NOMINA": Recibo de nómina CFDI (muestra percepciones, deducciones, RFC emisor/receptor, NSS, CURP, SBC, SDI, registro patronal). Extrae todos los datos del receptor (empleado).
   - "MULTI": El documento contiene datos de VARIOS tipos (ej. un contrato que incluye RFC, CURP y NSS).
   - "OTRO": cualquier otro documento.
4. Extrae TODOS los campos que puedas encontrar, sin importar el tipo de documento.
5. Fechas en formato ISO YYYY-MM-DD. Montos como números.
6. Para CURP: valida que tenga 18 caracteres alfanuméricos.
7. Para NSS: valida que tenga 11 dígitos.
8. Para RFC: valida 13 caracteres (persona física).

SCHEMA DE RESPUESTA:
{
  "type": "CURP" | "NSS" | "CONTRATO" | "ALTA_IMSS" | "INE" | "RFC_SAT" | "COMPROBANTE_DOMICILIO" | "MULTI" | "OTRO",
  "employee": {
    "nombre": string | null,
    "apellidoPaterno": string | null,
    "apellidoMaterno": string | null,
    "rfc": string | null,
    "curp": string | null,
    "nss": string | null,
    "fechaNacimiento": string | null,
    "sexo": "M" | "F" | null,
    "entidadNacimiento": string | null,
    "nacionalidad": string | null,
    "email": string | null,
    "telefono": string | null,
    "domicilio": string | null,
    "codigoPostal": string | null,
    "claveEntFed": string | null,
    "salarioDiario": number | null,
    "salarioDiarioIntegrado": number | null,
    "salarioBaseCotizacion": number | null,
    "salarioMensual": number | null,
    "puesto": string | null,
    "departamento": string | null,
    "tipoContrato": string | null,
    "tipoJornada": string | null,
    "periodicidadPago": string | null,
    "fechaIngreso": string | null,
    "fechaAlta": string | null,
    "numEmpleado": string | null,
    "creditoInfonavit": string | null,
    "tipoDescuentoInfonavit": "PCT_SBC" | "VSM" | "PESOS" | null,
    "descuentoInfonavit": number | null
  },
  "confidenceNotes": string | null
}

8. IMPORTANTE para salarios: "Sueldo diario" y "Salario diario integrado" (SDI) y "Salario base cotización" (SBC) son DIFERENTES. El campo salarioDiario debe ser el "Sueldo diario" (el más bajo de los tres). El SDI y SBC son más altos porque incluyen factor de integración. Si solo ves SBC/SDI pero no sueldo diario, pon salarioDiario como null.
9. Para CFDI nómina: si hay una deducción tipo "010" (Pago por crédito de vivienda/Infonavit), extrae el importe como descuentoInfonavit y pon tipoDescuentoInfonavit como "PESOS". Si el campo creditoInfonavit aparece, extráelo también.

Códigos SAT para tipoContrato: "01"=Indefinido, "02"=Temporal, "03"=Obra, "04"=Temporada, "05"=Prueba, "09"=Jubilado.
Códigos SAT para tipoJornada: "01"=Diurna, "02"=Nocturna, "03"=Mixta, "04"=Por hora, "99"=Otra.
Códigos SAT para periodicidadPago: "01"=Diario, "02"=Semanal, "04"=Quincenal, "05"=Mensual.
Claves entidad federativa: PUE=Puebla, CMX=Ciudad de México, JAL=Jalisco, NLE=Nuevo León, etc.`;

const USER_PROMPT = `Clasifica y extrae los datos del empleado de este documento. Solo JSON.`;

function validateCurp(curp: string | null): boolean {
  if (!curp) return false;
  return /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/.test(curp.toUpperCase());
}

function validateNss(nss: string | null): boolean {
  if (!nss) return false;
  return /^\d{11}$/.test(nss.replace(/\s/g, ""));
}

function validateRfc(rfc: string | null): boolean {
  if (!rfc) return false;
  return /^[A-Z&Ñ]{4}\d{6}[A-Z0-9]{3}$/.test(rfc.toUpperCase());
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "AI no configurado" }, { status: 503 });
  }

  let file: File | null = null;
  let companyId: string | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
    const c = form.get("companyId");
    if (typeof c === "string" && c.trim()) companyId = c.trim();
  } catch {
    return NextResponse.json({ error: "Formato inválido" }, { status: 400 });
  }

  if (!file) return NextResponse.json({ error: "Sube un archivo PDF" }, { status: 400 });
  if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: "Máximo 10 MB" }, { status: 413 });

  // Con empresa: membresía con permiso de escritura y tope de la empresa. Sin
  // empresa (alta de empleado antes de tener una): tope por usuario.
  const userId = session.user.id;
  if (companyId) {
    const member = await getEffectiveCompanyMembership(userId, companyId);
    if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }
  const guardia = await asegurarUsoIA({ userId, companyId });
  if (!guardia.ok) return respuestaTopeIA(guardia);

  const buf = Buffer.from(await file.arrayBuffer());
  const base64 = buf.toString("base64");

  // Detect media type
  const isPdf = file.type.includes("pdf") || file.name.toLowerCase().endsWith(".pdf");
  const isImage = file.type.startsWith("image/") || /\.(jpg|jpeg|png|webp)$/i.test(file.name);
  const mediaType = isPdf ? "application/pdf" : isImage ? (file.type || "image/jpeg") : "application/pdf";

  let responseText = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contentBlock: any = isPdf
      ? { type: "document", source: { type: "base64", media_type: mediaType, data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await meteredCreate(anthropic, { subtipo: "nomina.parse_empleado", companyId, userId }, {
      model: "claude-sonnet-4-5",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: [contentBlock, { type: "text", text: USER_PROMPT }] }],
    });
    const block = response.content.find((b: { type: string }) => b.type === "text");
    responseText = block?.text ?? "";
  } catch (e) {
    console.error("[parse-employee-docs] Anthropic error:", e);
    return NextResponse.json(
      { error: "No se pudo procesar el documento", detail: e instanceof Error ? e.message : "desconocido" },
      { status: 502 }
    );
  }

  const cleaned = responseText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  let parsed: { type: string; employee: Record<string, unknown>; confidenceNotes: string | null };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return NextResponse.json({ error: "Respuesta AI no fue JSON válido", raw: cleaned.slice(0, 500) }, { status: 502 });
  }

  // Normalize
  const emp = parsed.employee ?? {};
  if (typeof emp.curp === "string") emp.curp = emp.curp.toUpperCase().trim();
  if (typeof emp.rfc === "string") emp.rfc = emp.rfc.toUpperCase().trim();
  if (typeof emp.nss === "string") emp.nss = emp.nss.replace(/\s/g, "").trim();

  // Warnings
  const warnings: string[] = [];
  if (emp.curp && !validateCurp(emp.curp as string)) warnings.push(`CURP con formato inválido: ${emp.curp}`);
  if (emp.nss && !validateNss(emp.nss as string)) warnings.push(`NSS debe tener 11 dígitos: ${emp.nss}`);
  if (emp.rfc && !validateRfc(emp.rfc as string)) warnings.push(`RFC con formato inválido: ${emp.rfc}`);

  return NextResponse.json({
    ok: parsed.type !== "OTRO",
    type: parsed.type,
    employee: emp,
    warnings,
    confidenceNotes: parsed.confidenceNotes,
  });
}
