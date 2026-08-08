// ─────────────────────────────────────────────────────────────────────────────
// Mapeo de los RECURSOS de resultado de Syntage a nuestros tipos. Confirmado
// contra el OpenAPI de Syntage y una respuesta viva:
//   TaxComplianceCheck.result ∈ positive|negative|no_obligations|activity_suspended
//   TaxStatus → rfc, taxRegimes[].code, obligations[].description, address.postalCode, status
// OJO: estos son los recursos /tax-compliance-checks/{id} y /tax-status/{id},
// NO el objeto Extraction (que es sólo el job).
// ─────────────────────────────────────────────────────────────────────────────

import type { CsfResult, EstatusPadron, OpinionResult, ResultadoOpinion } from "../types";

type Json = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
// Para descargar el PDF se usa la ruta del archivo (/files/{id}); por eso se
// prefiere file["@id"] sobre file.resource (que apunta al recurso padre).
const fileRef = (f: unknown): string | undefined => {
  if (typeof f === "string") return f;
  if (f && typeof f === "object") return str((f as Json)["@id"]) ?? str((f as Json).resource);
  return undefined;
};

function mapResult(v: unknown): ResultadoOpinion {
  switch (String(v)) {
    case "positive":
      return "POSITIVA";
    case "negative":
      return "NEGATIVA";
    case "no_obligations":
      return "SIN_OBLIGACIONES";
    case "activity_suspended":
      return "NO_LOCALIZADO"; // suspendido: sin opinión vigente
    default:
      return "ERROR";
  }
}

function mapEstatus(v: unknown): EstatusPadron {
  const s = (str(v) ?? "").toUpperCase();
  if (s.includes("SUSP")) return "SUSPENDIDO";
  if (s.includes("CANCEL")) return "CANCELADO";
  if (s.includes("BAJA")) return "BAJA";
  if (s.includes("ACTIV")) return "ACTIVO";
  return "DESCONOCIDO";
}

/** Recurso TaxComplianceCheck → OpinionResult (SAT). */
export function mapTaxCompliance(check: Json, fetchedAt = new Date().toISOString()): OpinionResult {
  const folio = str(check.internalIdentifier);
  return {
    tipo: "SAT_OPINION",
    resultado: mapResult(check.result),
    // El detalle de la negativa vive en el PDF; conservamos el folio del SAT.
    motivos: folio ? [`Folio SAT: ${folio}`] : [],
    acuseUrl: fileRef(check.file),
    vigencia: str(check.checkedAt),
    fetchedAt,
  };
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Declaración anual derivada de un recurso TaxReturn de Syntage. */
export interface DeclaracionAnualSyntage {
  ejercicio: number;
  /** Importe pagado (o a cargo si no hay pagado); null si la anual no arroja pago. */
  isrPagar: number | null;
  lineaCaptura?: string;
  /** Fecha de presentación (ISO). */
  fechaPresentacion?: string;
  esComplementaria: boolean;
}

/**
 * Recurso TaxReturn → declaración ANUAL. Sólo mapea `intervalUnit === "Anual"`;
 * devuelve null para mensuales/RIF o si no se puede determinar el ejercicio.
 * Las mensuales NO se mapean: el recurso trae un único `payment` agregado, sin
 * desglose IVA/ISR, y nuestro modelo separa IVA_MENSUAL e ISR_PROVISIONAL con
 * importes propios. Campos confirmados en docs.syntage.com (tax-returns):
 * intervalUnit, fiscalYear/period, payment.{paidAmount,dueAmount}, captureLine,
 * presentedAt, type.
 */
export function mapTaxReturnAnual(tr: Json): DeclaracionAnualSyntage | null {
  if (String(tr.intervalUnit) !== "Anual") return null;
  const ejercicio = num(tr.fiscalYear) ?? num(tr.period);
  if (ejercicio == null) return null;
  const payment = (tr.payment as Json) ?? {};
  const tipo = String(tr.type ?? "");
  return {
    ejercicio,
    isrPagar: num(payment.paidAmount) ?? num(payment.dueAmount),
    lineaCaptura: str(tr.captureLine),
    fechaPresentacion: str(tr.presentedAt),
    esComplementaria: tipo.startsWith("Complementaria"),
  };
}

/**
 * Elige, por ejercicio, la declaración anual AUTORITATIVA entre las que Syntage
 * reporta: la de fecha de presentación MÁS RECIENTE — una complementaria
 * sustituye a la normal (y una complementaria más nueva a la anterior). El SAT
 * considera vigente la última presentada; procesar "la primera que venga en el
 * arreglo" (lo que hacía el loop) dejaba el coeficiente y las pérdidas de la
 * normal aunque existiera una complementaria posterior (caso real: la anual
 * 2025 de una empresa fue modificada por complementaria cinco meses después).
 *
 * Empates y faltantes: a igual fecha gana la complementaria (es la corrección);
 * una fecha ausente pierde contra cualquier fecha presente.
 */
export function anualesAutoritativas(
  returns: ReadonlyArray<Json>
): { tr: Json; anual: DeclaracionAnualSyntage }[] {
  const porEjercicio = new Map<number, { tr: Json; anual: DeclaracionAnualSyntage }>();
  for (const tr of returns) {
    const anual = mapTaxReturnAnual(tr);
    if (!anual) continue;
    const actual = porEjercicio.get(anual.ejercicio);
    if (!actual || gana(anual, actual.anual)) porEjercicio.set(anual.ejercicio, { tr, anual });
  }
  return [...porEjercicio.values()].sort((a, b) => b.anual.ejercicio - a.anual.ejercicio);
}

/** ¿`a` es más autoritativa que `b`? Fecha más reciente; empate → complementaria. */
function gana(a: DeclaracionAnualSyntage, b: DeclaracionAnualSyntage): boolean {
  const fa = a.fechaPresentacion ?? "";
  const fb = b.fechaPresentacion ?? "";
  if (fa !== fb) return fa > fb; // ISO: comparación lexicográfica = cronológica
  if (a.esComplementaria !== b.esComplementaria) return a.esComplementaria;
  return false;
}

/** Columnas de coeficiente/pérdida que se persisten en una DECLARACION_ANUAL a
 *  partir del acuse parseado. */
export interface CamposAnualAcuse {
  /** Ingresos NOMINALES — denominador del coeficiente (Art. 14). */
  isrIngresos: number | null;
  /** Utilidad fiscal del ejercicio — numerador del coeficiente. */
  isrBaseGravable: number | null;
  /** Coeficiente de utilidad derivado (utilidad ÷ ingresos nominales), 4 decimales. */
  isrCoeficienteUtilidad: number | null;
  /** Remanente de pérdidas pendiente de aplicar a futuro (actualizado). */
  isrPerdidaPendiente: number | null;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Deriva, de un acuse ANUAL parseado, las columnas que alimentan el coeficiente
 * de utilidad (Art. 14) y la amortización de pérdidas en los pagos provisionales
 * de PM. Función pura (sin DB/IA) — toda la sutileza fiscal vive aquí:
 *
 *  · El coeficiente usa INGRESOS NOMINALES como denominador (no los acumulables,
 *    que incluyen el ajuste anual por inflación) y la UTILIDAD FISCAL del
 *    ejercicio como numerador (no el resultado fiscal). Sólo se escribe el par
 *    ingresos/utilidad cuando ambos existen y la utilidad es > 0; en un ejercicio
 *    con pérdida se dejan en null para que el motor use el último año con utilidad.
 *  · La pérdida pendiente es el REMANENTE a aplicar a ejercicios futuros, no lo
 *    aplicado este año.
 */
export function camposAnualDesdeAcuse(a: {
  ingresosNominales: number | null;
  utilidadFiscal: number | null;
  perdidaFiscalRemanente: number | null;
  perdidasPendientes: number | null;
  coeficienteUtilidad: number | null;
}): CamposAnualAcuse {
  const ingresos = a.ingresosNominales;
  const utilidad = a.utilidadFiscal;
  const tieneCoef = ingresos != null && ingresos > 0 && utilidad != null && utilidad > 0;

  const isrIngresos = tieneCoef ? ingresos : null;
  const isrBaseGravable = tieneCoef ? utilidad : null;
  const isrCoeficienteUtilidad = tieneCoef
    ? round4(utilidad! / ingresos!)
    : a.coeficienteUtilidad != null && a.coeficienteUtilidad > 0
      ? round4(a.coeficienteUtilidad)
      : null;

  const remanente = a.perdidaFiscalRemanente ?? a.perdidasPendientes;
  const isrPerdidaPendiente = remanente != null && remanente > 0 ? round4(remanente) : null;

  return { isrIngresos, isrBaseGravable, isrCoeficienteUtilidad, isrPerdidaPendiente };
}

/**
 * Mezcla lo extraído del acuse sobre lo ya guardado en la fila (gap-fill):
 * un valor extraído no-null GANA (el acuse del SAT es la fuente autoritativa —
 * corrige filas con datos de parseos viejos, p. ej. la utilidad guardada como
 * ingresos), pero un null extraído NUNCA borra un valor existente (Claude puede
 * no encontrar un renglón en esa pasada). Devuelve null si nada cambia, para
 * que el llamador se ahorre el UPDATE.
 */
export function mergeCamposAnual(
  existentes: CamposAnualAcuse,
  extraidos: CamposAnualAcuse,
): CamposAnualAcuse | null {
  const merged: CamposAnualAcuse = {
    isrIngresos: extraidos.isrIngresos ?? existentes.isrIngresos,
    isrBaseGravable: extraidos.isrBaseGravable ?? existentes.isrBaseGravable,
    isrCoeficienteUtilidad: extraidos.isrCoeficienteUtilidad ?? existentes.isrCoeficienteUtilidad,
    isrPerdidaPendiente: extraidos.isrPerdidaPendiente ?? existentes.isrPerdidaPendiente,
  };
  const cambia = (Object.keys(merged) as (keyof CamposAnualAcuse)[]).some(
    (k) => merged[k] !== existentes[k],
  );
  return cambia ? merged : null;
}

/** Recurso TaxStatus → CsfResult (CSF). */
export function mapTaxStatus(ts: Json, fetchedAt = new Date().toISOString()): CsfResult {
  const address = (ts.address as Json) ?? {};
  const regimes = Array.isArray(ts.taxRegimes) ? (ts.taxRegimes as Json[]) : [];
  const obligations = Array.isArray(ts.obligations) ? (ts.obligations as Json[]) : [];
  return {
    tipo: "CSF",
    perfil: {
      rfc: str(ts.rfc) ?? "",
      regimenes: regimes.map((r) => String(r.code ?? "")).filter(Boolean),
      obligaciones: obligations.map((o) => str(o.description) ?? "").filter(Boolean),
      codigoPostal: str(address.postalCode),
      estatusPadron: mapEstatus(ts.status),
    },
    acuseUrl: fileRef(ts.file),
    fetchedAt,
  };
}
