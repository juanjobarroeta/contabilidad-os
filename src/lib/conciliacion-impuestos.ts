// ─────────────────────────────────────────────────────────────────────────────
// Conciliación de pagos de impuestos contra el estado de cuenta.
//
// Cuando la empresa paga su SIPARE (cuotas IMSS) o una declaración federal
// (línea de captura), el cargo aparece como movimiento bancario. Conciliar ese
// movimiento con la fila TaxDeclaration marca el pago como PAID y el movimiento
// como MATCHED en un solo gesto (action "match-impuesto" del PATCH de
// transacciones), en lugar de capturarlo dos veces (registrar pago manual +
// categorizar el movimiento).
//
// Este módulo contiene SÓLO decisiones puras (sin prisma, sin @prisma/client en
// runtime) para que sean testeables con casos dorados y para que la página de
// /bancos (client component) pueda importar las etiquetas sin arrastrar nada de
// servidor. Los callers (PATCH de transacciones, GET de candidatos, estado
// IMSS) aportan las filas y aplican los efectos.
//
// Reglas v1 (documentadas donde se aplican):
//   - Un movimiento paga UNA declaración y una declaración se paga con UN
//     movimiento. Un segundo movimiento sobre la misma declaración se rechaza
//     con 409 (un pago en partes de una línea de captura no existe en v1).
//   - Sólo egresos (monto < 0) y movimientos UNMATCHED.
//   - Tolerancia de monto ±1% contra el monto a pagar derivado por tipo; si la
//     fila no trae monto esperado (null/0 — p. ej. IMSS sin estimado), se
//     acepta cualquier monto y el caller guarda el pagado en el campo del tipo,
//     espejando el «Registrar pago» manual.
//   - Al desconciliar, la declaración regresa a su estatus anterior SIN guardar
//     nada extra: PAID → FILED si hay evidencia de presentación (acuse o línea
//     de captura), si no → CALCULATED. Ver statusTrasDesconciliar.
// ─────────────────────────────────────────────────────────────────────────────

/** Tipos de declaración que se pueden conciliar contra un movimiento bancario. */
export const TIPOS_IMPUESTO_CONCILIABLES = [
  "IVA_MENSUAL",
  "ISR_PROVISIONAL",
  "RETENCIONES_ISR",
  "IMSS_MENSUAL",
  "IMSS_BIMESTRAL",
] as const;

export type TipoImpuestoConciliable = (typeof TIPOS_IMPUESTO_CONCILIABLES)[number];

export function esTipoImpuestoConciliable(tipo: string): tipo is TipoImpuestoConciliable {
  return (TIPOS_IMPUESTO_CONCILIABLES as readonly string[]).includes(tipo);
}

/** Tolerancia de monto contra el monto a pagar de la declaración (±1%). */
export const TOLERANCIA_MONTO_IMPUESTO = 0.01;

/** Ventana de periodos recientes que se ofrecen como candidatos (acotada). */
export const PERIODOS_RECIENTES_IMPUESTO = 4;

/** Ventana en días para la sugerencia de movimiento desde el lado IMSS. */
export const VENTANA_DIAS_SUGERENCIA = 3;

// ── Monto a pagar por tipo ────────────────────────────────────────────────────

/** Campos de monto de TaxDeclaration relevantes para derivar el monto a pagar. */
export interface MontosDeclaracion {
  ivaPagar?: number | null;
  isrPagar?: number | null;
  retencionesIsr?: number | null;
  imssCuotas?: number | null;
}

/** Campo de TaxDeclaration donde vive el monto a pagar de cada tipo. */
export function campoMontoPorTipo(
  tipo: TipoImpuestoConciliable
): "ivaPagar" | "isrPagar" | "retencionesIsr" | "imssCuotas" {
  switch (tipo) {
    case "IVA_MENSUAL":
      return "ivaPagar";
    case "ISR_PROVISIONAL":
      return "isrPagar";
    case "RETENCIONES_ISR":
      return "retencionesIsr";
    case "IMSS_MENSUAL":
    case "IMSS_BIMESTRAL":
      return "imssCuotas";
  }
}

/**
 * Monto a pagar esperado de la declaración según su tipo, o null cuando la
 * fila no lo trae (null o 0 — p. ej. IMSS registrado sin estimado). Null
 * significa «sin expectativa»: se acepta cualquier monto y el pagado se guarda
 * en el campo del tipo, igual que el registrar manual.
 */
export function montoEsperadoDeclaracion(
  decl: { tipo: string } & MontosDeclaracion
): number | null {
  if (!esTipoImpuestoConciliable(decl.tipo)) return null;
  const valor = decl[campoMontoPorTipo(decl.tipo)];
  if (valor == null || !isFinite(valor) || valor <= 0) return null;
  return valor;
}

// ── Guard del match ───────────────────────────────────────────────────────────

export type ImpuestoMatchGuardResult =
  | { ok: true; montoEsperado: number | null }
  | { ok: false; error: string; status: 400 | 409 | 422 };

function fmtMonto(n: number): string {
  return `$${Math.abs(n).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Decisión PURA: ¿puede conciliarse este movimiento con esta declaración?
 * El caller ya validó sesión/permisos y que la declaración pertenece a la
 * misma empresa que el movimiento; aporta los movimientos MATCHED ya
 * vinculados a la declaración.
 *
 * Reglas:
 *   - El movimiento debe ser un EGRESO (monto < 0) — un depósito no paga
 *     impuestos — y estar UNMATCHED.
 *   - El tipo debe ser conciliable (no DIOT/ANUAL/CERO en v1).
 *   - v1: una declaración ↔ UN movimiento. Si ya hay otro movimiento MATCHED
 *     vinculado, se rechaza con 409 (pagos en partes no soportados en v1;
 *     desvincule el anterior para corregir). Una declaración PAID capturada a
 *     mano (sin movimiento vinculado) SÍ se puede conciliar: el match sólo le
 *     adjunta la evidencia bancaria.
 *   - Tolerancia ±1% contra el monto a pagar del tipo; sin monto esperado
 *     (null/0) se acepta cualquier monto.
 */
export function checkImpuestoMatchGuard(
  decl: { id: string; tipo: string } & MontosDeclaracion,
  movimientosVinculados: { id: string }[],
  tx: { id: string; monto: number; status: string }
): ImpuestoMatchGuardResult {
  if (!esTipoImpuestoConciliable(decl.tipo)) {
    return {
      ok: false,
      status: 422,
      error: `Una declaración de tipo ${decl.tipo} no se concilia contra el banco (sólo IVA, ISR provisional, retenciones ISR e IMSS).`,
    };
  }
  if (tx.status !== "UNMATCHED") {
    return {
      ok: false,
      status: 409,
      error: "El movimiento ya está conciliado o ignorado. Desvincúlelo antes de conciliarlo de nuevo.",
    };
  }
  if (!(tx.monto < 0)) {
    return {
      ok: false,
      status: 422,
      error: "Sólo un retiro (egreso) puede conciliarse como pago de impuestos; este movimiento es un depósito.",
    };
  }
  const otros = movimientosVinculados.filter((m) => m.id !== tx.id);
  if (otros.length > 0) {
    return {
      ok: false,
      status: 409,
      error:
        "Esta declaración ya está conciliada con otro movimiento bancario. " +
        "Una línea de captura se paga con un solo movimiento; desvincule el anterior si desea corregir la conciliación.",
    };
  }
  const esperado = montoEsperadoDeclaracion(decl);
  if (esperado != null) {
    const pagado = Math.abs(tx.monto);
    if (Math.abs(pagado - esperado) > esperado * TOLERANCIA_MONTO_IMPUESTO) {
      return {
        ok: false,
        status: 422,
        error:
          `El monto del movimiento (${fmtMonto(pagado)}) no coincide con el monto a pagar ` +
          `de la declaración (${fmtMonto(esperado)}, tolerancia 1%). ` +
          `Si la cifra correcta es la del banco, actualice primero la declaración.`,
      };
    }
  }
  return { ok: true, montoEsperado: esperado };
}

// ── Reversa del unmatch ───────────────────────────────────────────────────────

/**
 * Estatus al que regresa una declaración PAID cuando se desconcilia el
 * movimiento que la pagó. No se guarda ningún estado extra (v1), así que la
 * regla es determinista a partir de la evidencia presente en la fila:
 *
 *   - Hay evidencia de PRESENTACIÓN (acuseUrl, acuse PDF guardado o línea de
 *     captura) → FILED: la declaración se presentó; sólo se revierte el pago.
 *   - Sin evidencia → CALCULATED: la fila nació del cálculo (o del estimado
 *     IMSS) y el match fue lo único que la movió.
 *
 * Nota documentada: si la declaración se había marcado PAID a mano ANTES de
 * conciliarla, el unmatch también la baja de PAID — el vínculo bancario era la
 * evidencia más fuerte y al quitarlo el pago queda de nuevo por confirmar.
 */
export function statusTrasDesconciliar(decl: {
  acuseUrl?: string | null;
  acusePdfNombre?: string | null;
  lineaCaptura?: string | null;
}): "FILED" | "CALCULATED" {
  const tieneAcuse = Boolean(decl.acuseUrl || decl.acusePdfNombre || decl.lineaCaptura);
  return tieneAcuse ? "FILED" : "CALCULATED";
}

// ── Candidatos: filtrado y scoring ────────────────────────────────────────────

/**
 * Periodos "YYYY-MM" recientes respecto a la fecha del movimiento: el mes del
 * movimiento y los n-1 anteriores. Un pago siempre corresponde a un periodo
 * anterior o al del propio mes (SIPARE de enero se paga ~17 de febrero), así
 * que esta ventana acotada cubre pagos hasta ~3 meses tardíos con n = 4.
 */
export function periodosRecientes(fecha: Date, n: number = PERIODOS_RECIENTES_IMPUESTO): string[] {
  const out: string[] = [];
  let year = fecha.getFullYear();
  let month = fecha.getMonth() + 1;
  for (let i = 0; i < n; i++) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return out;
}

export interface DeclCandidataImpuesto extends MontosDeclaracion {
  id: string;
  tipo: string;
  periodo: string;
  status: string;
  fechaLimitePago?: Date | null;
  /**
   * true cuando la fila NO tiene ningún movimiento bancario MATCHED vinculado.
   * El caller (que sí ve los movimientos) lo aporta; sin el flag (undefined)
   * una fila PAID se excluye, conservando el comportamiento previo.
   */
  sinEvidenciaBancaria?: boolean;
}

/**
 * Filtro PURO de candidatas: tipo conciliable, con algo que pagar — un renglón
 * de IVA/ISR/retenciones con monto a pagar null/0 (p. ej. saldo a favor) no es
 * pagable y se excluye; IMSS sin estimado SÍ se ofrece (el SUA determina la
 * cifra y se acepta cualquier monto).
 *
 * Una fila PAID sólo es candidata cuando el caller la marca
 * `sinEvidenciaBancaria: true`: es un pago capturado a mano (p. ej. SIPARE
 * registrado en la pestaña Cumplimiento de nómina) al que el match únicamente
 * le adjunta la evidencia bancaria — misma regla que checkImpuestoMatchGuard.
 */
export function filtrarCandidatosImpuesto<T extends DeclCandidataImpuesto>(decls: T[]): T[] {
  return decls.filter((d) => {
    if (!esTipoImpuestoConciliable(d.tipo)) return false;
    if (d.status === "PAID" && d.sinEvidenciaBancaria !== true) return false;
    const esperado = montoEsperadoDeclaracion(d);
    if (esperado == null && d.tipo !== "IMSS_MENSUAL" && d.tipo !== "IMSS_BIMESTRAL") return false;
    return true;
  });
}

// ── Línea de captura en la descripción del movimiento ─────────────────────────

/**
 * Longitud mínima (en caracteres alfanuméricos) para que una línea de captura
 * cuente como señal: las líneas SIPARE/SAT rondan los 20 caracteres; por
 * debajo de este piso una coincidencia sería ruido (folios, importes).
 */
export const MIN_LINEA_CAPTURA = 8;

function soloAlfanumerico(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * ¿La descripción del movimiento contiene la línea de captura registrada?
 * PURA. Compara sobre los caracteres alfanuméricos en mayúsculas (los bancos
 * insertan espacios o guiones al transcribirla) y exige una longitud mínima
 * para no puntuar coincidencias accidentales.
 */
export function coincideLineaCaptura(
  lineaCaptura: string | null | undefined,
  descripcion: string | null | undefined
): boolean {
  if (!lineaCaptura || !descripcion) return false;
  const linea = soloAlfanumerico(lineaCaptura);
  if (linea.length < MIN_LINEA_CAPTURA) return false;
  return soloAlfanumerico(descripcion).includes(linea);
}

/**
 * Score PURO de una declaración candidata frente a un movimiento (egreso).
 * Mismas bandas que el scoring de facturas (conciliacion.ts) para que las
 * chips de confianza signifiquen lo mismo en toda la página:
 *   monto: exacto +100 · <0.5% +70 · ≤1% +40 (sin esperado: 0, decide la fecha)
 *   fecha: ≤1d +30 · ≤3d +20 · ≤7d +10 · ≤15d +5 — contra la fecha de pago
 *     registrada (`fechaPago`, p. ej. la capturada al registrar el SIPARE en
 *     Cumplimiento) cuando existe; si no, contra la fecha límite de pago.
 *   línea de captura: +25 si la descripción del movimiento la contiene
 *     (mismo peso que el RFC en el scoring de facturas).
 */
export function scoreCandidatoImpuesto(
  decl: {
    montoEsperado: number | null;
    fechaLimitePago: Date | null;
    fechaPago?: Date | null;
    lineaCaptura?: string | null;
  },
  tx: { monto: number; fecha: Date; descripcion?: string | null }
): number {
  let score = 0;
  const pagado = Math.abs(tx.monto);
  if (decl.montoEsperado != null && decl.montoEsperado > 0) {
    const diff = Math.abs(pagado - decl.montoEsperado);
    if (diff < 0.01) score += 100;
    else if (diff / decl.montoEsperado < 0.005) score += 70;
    else if (diff / decl.montoEsperado <= TOLERANCIA_MONTO_IMPUESTO) score += 40;
  }
  const fechaRef = decl.fechaPago ?? decl.fechaLimitePago;
  if (fechaRef) {
    const dias = Math.abs(fechaRef.getTime() - tx.fecha.getTime()) / 86_400_000;
    if (dias <= 1) score += 30;
    else if (dias <= 3) score += 20;
    else if (dias <= 7) score += 10;
    else if (dias <= 15) score += 5;
  }
  if (coincideLineaCaptura(decl.lineaCaptura, tx.descripcion)) score += 25;
  return score;
}

export function confianzaImpuesto(score: number): "alta" | "media" | "baja" {
  return score >= 100 ? "alta" : score >= 50 ? "media" : "baja";
}

// ── Etiquetas ─────────────────────────────────────────────────────────────────

const MESES_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function partesPeriodo(periodo: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(periodo);
  if (!m) return null;
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  return { year: parseInt(m[1], 10), month };
}

/**
 * Etiqueta humana del pago: «IVA enero 2026», «IMSS mensual enero 2026
 * (SIPARE)», «RCV e Infonavit ene-feb 2026 (SIPARE)». El periodo bimestral se
 * llavea con el mes que CIERRA el bimestre (misma convención que imss-pagos).
 */
export function etiquetaImpuesto(tipo: string, periodo: string): string {
  const p = partesPeriodo(periodo);
  const mesLargo = p ? `${MESES_ES[p.month - 1]} ${p.year}` : periodo;
  switch (tipo) {
    case "IVA_MENSUAL":
      return `IVA ${mesLargo}`;
    case "ISR_PROVISIONAL":
      return `ISR provisional ${mesLargo}`;
    case "RETENCIONES_ISR":
      return `Retenciones ISR ${mesLargo}`;
    case "IMSS_MENSUAL":
      return `IMSS mensual ${mesLargo} (SIPARE)`;
    case "IMSS_BIMESTRAL": {
      if (!p) return `RCV e Infonavit ${periodo} (SIPARE)`;
      const mesInicio = p.month - 1 >= 1 ? p.month - 1 : 12;
      return `RCV e Infonavit ${MESES_CORTOS[mesInicio - 1]}-${MESES_CORTOS[p.month - 1]} ${p.year} (SIPARE)`;
    }
    default:
      return `${tipo} ${mesLargo}`;
  }
}

// ── Sugerencia desde el lado IMSS/declaración ─────────────────────────────────

export interface MovimientoParaSugerencia {
  id: string;
  fecha: Date;
  descripcion: string;
  monto: number;
  status: string;
}

/**
 * Mejor movimiento UNMATCHED para sugerir como pago de una obligación: egreso
 * dentro de ±3 días de la fecha límite y ±1% del monto objetivo (estimado o
 * cifra registrada). PURA — el caller acota la consulta y NO auto-aplica nada:
 * los pagos de impuestos son de alto riesgo, la sugerencia sólo se muestra.
 * Desempata por cercanía de monto y luego de fecha. Null si no hay objetivo
 * (> 0) o ningún movimiento califica.
 */
export function elegirMovimientoSugerido(
  objetivo: number,
  fechaLimite: Date,
  movimientos: MovimientoParaSugerencia[]
): MovimientoParaSugerencia | null {
  if (!isFinite(objetivo) || objetivo <= 0) return null;
  const candidatos = movimientos.filter((m) => {
    if (m.status !== "UNMATCHED" || !(m.monto < 0)) return false;
    const dias = Math.abs(m.fecha.getTime() - fechaLimite.getTime()) / 86_400_000;
    if (dias > VENTANA_DIAS_SUGERENCIA) return false;
    return Math.abs(Math.abs(m.monto) - objetivo) <= objetivo * TOLERANCIA_MONTO_IMPUESTO;
  });
  if (candidatos.length === 0) return null;
  return candidatos.sort((a, b) => {
    const diffA = Math.abs(Math.abs(a.monto) - objetivo);
    const diffB = Math.abs(Math.abs(b.monto) - objetivo);
    if (diffA !== diffB) return diffA - diffB;
    const diasA = Math.abs(a.fecha.getTime() - fechaLimite.getTime());
    const diasB = Math.abs(b.fecha.getTime() - fechaLimite.getTime());
    return diasA - diasB;
  })[0];
}
