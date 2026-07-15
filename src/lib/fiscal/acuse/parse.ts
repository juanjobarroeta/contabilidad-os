// ─────────────────────────────────────────────────────────────────────────────
// Parser de documentos SAT/IMSS con Claude (visión/PDF). Núcleo reutilizable:
// lo usa el wizard de onboarding (POST /api/onboarding/parse-document) y el
// backfill de declaraciones (descarga el acuse mensual de Syntage y lo parsea
// para obtener el desglose IVA/ISR que el recurso estructurado no trae).
//
// Una sola llamada a Claude CLASIFICA y EXTRAE. Devuelve JSON crudo tipado; la
// normalización específica (p.ej. resolver claves de régimen del CSF) vive en
// cada llamador.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { recordLlmCost, type CostCtx } from "@/lib/costos/record";

// Lazy: no instanciar al importar (así el módulo no exige ANTHROPIC_API_KEY en
// import-time, p.ej. en tests que sólo usan los tipos/helpers).
let _anthropic: Anthropic | null = null;
const anthropic = () => (_anthropic ??= new Anthropic());

export const VALID_REGIMENES = new Set([
  "601", "603", "605", "606", "607", "608", "610", "611", "612", "614",
  "615", "616", "620", "621", "622", "623", "624", "625", "626",
]);

export const REGIMEN_LABELS: Record<string, string> = {
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

const REGIMEN_CATALOG = Object.entries(REGIMEN_LABELS)
  .map(([code, label]) => `${code} — ${label}`)
  .join("\n");

const SYSTEM_PROMPT = `Eres un asistente experto en documentos fiscales del SAT y del IMSS mexicanos. Tu tarea es CLASIFICAR un documento y EXTRAER sus datos estructurados en una sola pasada.

REGLAS CRÍTICAS:
1. SOLO devuelves un objeto JSON válido. Nada de markdown, nada de explicaciones.
2. Si un campo no aparece, devuelve null. NO inventes valores.
3. Primero determina "type" examinando el encabezado, sellos y estructura del documento:
   - "CSF": Constancia de Situación Fiscal del SAT (dice "Constancia de Situación Fiscal", muestra RFC, régimen fiscal, obligaciones).
   - "TARJETA_IMSS": Tarjeta de Identificación Patronal del IMSS (muestra Registro Patronal, clase, prima, actividad económica IMSS).
   - "ACUSE_ANUAL": Acuse de declaración ANUAL del SAT (dice "Declaración Anual", muestra ejercicio, coeficiente de utilidad, utilidad fiscal, ISR causado). TAMBIÉN es ACUSE_ANUAL el formato largo "DECLARACIÓN DEL EJERCICIO / ISR PERSONAS MORALES" (transcript de 20+ páginas con todos los renglones del formulario: INGRESOS, DEDUCCIONES AUTORIZADAS, DETERMINACIÓN).
   - "ACUSE_MENSUAL": Acuse de pago mensual / provisional / definitivo (dice "Pago provisional", "Pago definitivo", "Declaración mensual", muestra periodo mes/año, IVA o ISR).
   - "OTRO": cualquier otro documento.
4. Devuelve los campos correspondientes al type detectado. Los demás quedan como null o arrays vacíos.
5. Fechas en formato ISO YYYY-MM-DD. Montos como números (no strings, sin símbolos).
6. Para CSF: en la sección "Regímenes" del documento los regímenes aparecen por su NOMBRE, no por su clave numérica. Detecta TODOS los que estén listados (pueden ser varios) y asigna a cada uno su clave de 3 dígitos usando el catálogo de abajo. Devuélvelos en "regimenes" como array de { code, label, since } donde "code" es la clave de 3 dígitos y "label" el nombre. Si hay más de uno, deja "regimenFiscal" (el principal) en null para que el usuario elija; NO inventes uno.
7. Para ACUSE_ANUAL (declaración anual de Persona Moral), distingue con cuidado dos pares de cifras que suelen confundirse:
   - "ingresosNominales" = el renglón "INGRESOS NOMINALES" (base para el coeficiente de utilidad del Art. 14). NO es lo mismo que "ingresosAcumulables" (= "TOTAL DE INGRESOS ACUMULABLES", que incluye el ajuste anual por inflación acumulable). Extrae AMBOS por separado; si sólo aparece uno, deja el otro en null.
   - "utilidadFiscal" = "UTILIDAD FISCAL DEL EJERCICIO" (antes de restar pérdidas de ejercicios anteriores), NO el "RESULTADO FISCAL".
   - "perdidaFiscalRemanente" = el "REMANENTE" de pérdidas fiscales de ejercicios anteriores que queda PENDIENTE de aplicar a ejercicios FUTUROS (la columna "Remanente" de la tabla de pérdidas, ya actualizada). NO es el monto aplicado en este ejercicio ni las "PÉRDIDAS FISCALES DE EJERCICIOS ANTERIORES" restadas este año. "perdidasPendientes" puede dejarse igual al remanente si el documento no las separa. En el formato largo la tabla vive en la sección DETERMINACIÓN con columnas "PÉRDIDAS PENDIENTES DE APLICAR / PÉRDIDA FISCAL ACTUALIZADA / POR APLICAR EN ESTE EJERCICIO / REMANENTE": toma el renglón "Total" de la columna REMANENTE (suma de todas las pérdidas por año de origen). El "LÍMITE DE PÉRDIDAS A APLICAR" y el "MONTO POR APLICAR" NO son el remanente.

CATÁLOGO DE RÉGIMENES (clave — nombre). Usa exactamente estas claves:
${REGIMEN_CATALOG}

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
    "ingresosNominales": number | null,
    "ingresosAcumulables": number | null,
    "deduccionesAutorizadas": number | null,
    "utilidadFiscal": number | null,
    "perdidasPendientes": number | null,
    "perdidaFiscalRemanente": number | null,
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

export interface CsfData {
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
}

export interface AcuseMensual {
  rfc: string | null;
  periodoMes: number | null;
  periodoAnio: number | null;
  tipoImpuesto: "IVA" | "ISR" | "IVA_ISR" | "RETENCIONES" | null;
  tipoPago: "PROVISIONAL" | "DEFINITIVO" | "NORMAL" | "COMPLEMENTARIA" | null;
  ivaCausado: number | null;
  ivaAcreditable: number | null;
  ivaAPagar: number | null;
  ivaAFavor: number | null;
  ivaSaldoFavorAplicado: number | null;
  isrIngresos: number | null;
  isrRetenciones: number | null;
  isrPagosAnteriores: number | null;
  isrAPagar: number | null;
  coeficienteUtilidadAplicado: number | null;
  lineaCaptura: string | null;
  fechaPresentacion: string | null;
}

export interface AcuseAnual {
  ejercicio: number | null;
  rfc: string | null;
  tipo: "NORMAL" | "COMPLEMENTARIA" | null;
  /** "INGRESOS NOMINALES" — denominador del coeficiente de utilidad (Art. 14). */
  ingresosNominales: number | null;
  /** "TOTAL DE INGRESOS ACUMULABLES" (incluye ajuste anual por inflación). */
  ingresosAcumulables: number | null;
  deduccionesAutorizadas: number | null;
  /** "UTILIDAD FISCAL DEL EJERCICIO" — numerador del coeficiente (Art. 14). */
  utilidadFiscal: number | null;
  perdidasPendientes: number | null;
  /** "Remanente" de pérdidas pendiente de aplicar a ejercicios FUTUROS (actualizado). */
  perdidaFiscalRemanente: number | null;
  resultadoFiscal: number | null;
  isrCausado: number | null;
  isrAcreditable: number | null;
  isrAPagar: number | null;
  isrAFavor: number | null;
  coeficienteUtilidad: number | null;
  lineaCaptura: string | null;
  fechaPresentacion: string | null;
}

export interface ParsedSatDocument {
  type: "CSF" | "TARJETA_IMSS" | "ACUSE_ANUAL" | "ACUSE_MENSUAL" | "OTRO";
  csf: CsfData | null;
  imss: Record<string, unknown> | null;
  acuseAnual: AcuseAnual | null;
  acuseMensual: AcuseMensual | null;
  confidenceNotes: string | null;
}

/**
 * Clasifica + extrae un documento SAT/IMSS (PDF en base64) con una sola llamada
 * a Claude. Lanza si Anthropic falla o si la respuesta no es JSON válido — el
 * llamador decide cómo degradar.
 */
export async function parseSatDocument(base64: string, cost?: CostCtx): Promise<ParsedSatDocument> {
  const model = "claude-sonnet-4-5";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: any = await anthropic().messages.create({
    model,
    max_tokens: 3072,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
          { type: "text", text: USER_PROMPT },
        ],
      },
    ],
  });
  // Métrica de costo (fire-and-forget; no bloquea ni rompe el parseo).
  void recordLlmCost(response?.model ?? model, response?.usage, {
    ...cost,
    subtipo: cost?.subtipo ?? "llm.parse_document",
  });
  const block = response.content.find((b: { type: string }) => b.type === "text");
  const cleaned = (block?.text ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned) as ParsedSatDocument;
}
