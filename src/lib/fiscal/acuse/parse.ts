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
import { REGIMEN_LABELS, VALID_REGIMENES } from "@/lib/fiscal/regimen-capabilities";

// Compatibilidad para los llamadores históricos de este parser. El catálogo
// canónico vive en regimen-capabilities.ts.
export { REGIMEN_LABELS, VALID_REGIMENES };

// Lazy: no instanciar al importar (así el módulo no exige ANTHROPIC_API_KEY en
// import-time, p.ej. en tests que sólo usan los tipos/helpers).
let _anthropic: Anthropic | null = null;
const anthropic = () => (_anthropic ??= new Anthropic());

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
   - "ACUSE_MENSUAL": Acuse de pago mensual / provisional / definitivo (dice "Pago provisional", "Pago definitivo", "Declaración mensual", muestra periodo mes/año, IVA, ISR o IEPS). Un mismo acuse puede combinar varios impuestos: si trae renglones de IEPS (Impuesto Especial sobre Producción y Servicios — bebidas saborizadas, alcohol, tabacos, botanas, etc.), extrae "iepsAPagar" y "iepsAFavor" ADEMÁS de los campos de IVA/ISR que aparezcan; "tipoImpuesto" describe solo la parte IVA/ISR.
   - "OTRO": cualquier otro documento.
4. Devuelve los campos correspondientes al type detectado. Los demás quedan como null o arrays vacíos.
5. Fechas en formato ISO YYYY-MM-DD. Montos como números (no strings, sin símbolos).
6. Para CSF: en la sección "Regímenes" del documento los regímenes aparecen por su NOMBRE, no por su clave numérica. Detecta TODOS los que estén listados (pueden ser varios) y asigna a cada uno su clave de 3 dígitos usando el catálogo de abajo. Devuélvelos en "regimenes" como array de { code, label, since } donde "code" es la clave de 3 dígitos y "label" el nombre. Si hay más de uno, deja "regimenFiscal" (el principal) en null para que el usuario elija; NO inventes uno.
7. Para ACUSE_ANUAL (declaración anual de Persona Moral), distingue con cuidado dos pares de cifras que suelen confundirse:
   - "ingresosNominales" = el renglón "INGRESOS NOMINALES" (base para el coeficiente de utilidad del Art. 14). NO es lo mismo que "ingresosAcumulables" (= "TOTAL DE INGRESOS ACUMULABLES", que incluye el ajuste anual por inflación acumulable). Extrae AMBOS por separado; si sólo aparece uno, deja el otro en null.
   - "utilidadFiscal" = "UTILIDAD FISCAL DEL EJERCICIO" (antes de restar pérdidas de ejercicios anteriores), NO el "RESULTADO FISCAL".
   - "perdidaFiscalRemanente" = el "REMANENTE" de pérdidas fiscales de ejercicios anteriores que queda PENDIENTE de aplicar a ejercicios FUTUROS (la columna "Remanente" de la tabla de pérdidas, ya actualizada). NO es el monto aplicado en este ejercicio ni las "PÉRDIDAS FISCALES DE EJERCICIOS ANTERIORES" restadas este año. "perdidasPendientes" puede dejarse igual al remanente si el documento no las separa. En el formato largo la tabla vive en la sección DETERMINACIÓN con columnas "PÉRDIDAS PENDIENTES DE APLICAR / PÉRDIDA FISCAL ACTUALIZADA / POR APLICAR EN ESTE EJERCICIO / REMANENTE": toma el renglón "Total" de la columna REMANENTE (suma de todas las pérdidas por año de origen). El "LÍMITE DE PÉRDIDAS A APLICAR" y el "MONTO POR APLICAR" NO son el remanente.

8. Para ACUSE_MENSUAL, un mismo acuse suele traer VARIOS conceptos (obligaciones) uno tras otro, cada uno con su propio "IMPUESTO A CARGO" / "CANTIDAD A PAGAR". NO los sumes ni los mezcles:
   - "isrAPagar" es SOLO el ISR PROPIO del contribuyente: el concepto "ISR personas morales", "ISR personas físicas actividad empresarial y profesional", "ISR simplificado de confianza" o similar. Si ese concepto dice 0, "isrAPagar" es 0 aunque otros conceptos tengan importe.
   - "retencionesSalarios" = suma de los conceptos "ISR retenciones por salarios" + "ISR retenciones por asimilados a salarios" (impuesto de los trabajadores que el patrón entera).
   - "retencionesTerceros" = suma de "ISR retenciones por servicios profesionales", "ISR retenciones por arrendamiento" y demás retenciones de ISR a terceros distintas de salarios.
   - "isrRetenciones" son las retenciones que a ESTE contribuyente le hicieron sus clientes (se acreditan contra su ISR propio); no confundir con las dos anteriores.
   - "ivaAPagar" es la "CANTIDAD A PAGAR" del concepto "Impuesto al Valor Agregado"; el concepto "IVA retenciones" NO entra ahí.

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
    "retencionesSalarios": number | null,
    "retencionesTerceros": number | null,
    "coeficienteUtilidadAplicado": number | null,
    "iepsAPagar": number | null,
    "iepsAFavor": number | null,
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
  /** ISR retenido a trabajadores (salarios + asimilados) que el patrón entera: concepto aparte del ISR propio. */
  retencionesSalarios?: number | null;
  /** ISR retenido a terceros (servicios profesionales, arrendamiento, …) a enterar. */
  retencionesTerceros?: number | null;
  coeficienteUtilidadAplicado: number | null;
  /** Renglones de IEPS del acuse (RESICO/actividad con IEPS los combina en el
   *  mismo acuse mensual que IVA/ISR). Null si el acuse no trae IEPS. */
  iepsAPagar: number | null;
  iepsAFavor: number | null;
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
 * Error de parseo DESPUÉS de pagar la llamada: la respuesta llegó (y su costo
 * quedó registrado en CostEvent) pero no se pudo interpretar. El llamador debe
 * tratarlo distinto de un fallo de red — reintentarlo en cada corrida vuelve a
 * pagar por el mismo documento indefinidamente. Caso real: 3 acuses anuales de
 * una empresa cuya respuesta no validaba → 249 llamadas / ~$45 USD en 10 días
 * (el guard de acuseParseadoAt no marcaba porque el catch "reintenta la
 * próxima corrida" asumía errores gratuitos).
 */
export class SatParsePagadoError extends Error {
  readonly pagado = true;
  constructor(message: string, readonly crudo?: string) {
    super(message);
    this.name = "SatParsePagadoError";
  }
}

/**
 * Clasifica + extrae un documento SAT/IMSS (PDF en base64) con una sola llamada
 * a Claude. Un fallo de Anthropic (red/API) lanza el error original — GRATIS,
 * reintentable. Una respuesta pagada que no se puede interpretar lanza
 * SatParsePagadoError — el llamador decide, sabiendo que ya costó.
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
  try {
    return JSON.parse(cleaned) as ParsedSatDocument;
  } catch {
    // Rescate barato antes de rendirse: el modelo a veces antepone una frase
    // al JSON ("Aquí está el análisis: {...}"). El primer bloque {...} externo
    // suele ser el documento completo.
    const desde = cleaned.indexOf("{");
    const hasta = cleaned.lastIndexOf("}");
    if (desde >= 0 && hasta > desde) {
      try {
        return JSON.parse(cleaned.slice(desde, hasta + 1)) as ParsedSatDocument;
      } catch {
        /* cae al error pagado */
      }
    }
    throw new SatParsePagadoError(
      `respuesta pagada no interpretable (${cleaned.length} chars)`,
      cleaned.slice(0, 300),
    );
  }
}
