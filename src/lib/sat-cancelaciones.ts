// ─────────────────────────────────────────────────────────────────────────────
// Detección de CFDIs cancelados en el SAT (descarga de METADATA).
//
// La sincronización normal baja XML de CFDIs *vigentes*. Cuando una factura se
// cancela en el SAT después de que la importamos, nuestra copia sigue STAMPED y
// el motor fiscal la sigue contando — IVA/ISR inflados. La consulta de metadata
// (RequestType "metadata") devuelve, por cada CFDI del periodo, su
// `estatus` (vigente/cancelado) y `fechaCancelacion`; con eso revertimos el
// efecto marcando la factura CANCELLED (el motor ya excluye ese estado).
//
// Este módulo es PURO: interpreta los renglones de metadata contra lo que
// tenemos en BD y decide qué cancelar. La descarga vive en sat-sync.ts. Así la
// regla de decisión —la parte delicada— es unit-testeable sin tocar el SAT.
// ─────────────────────────────────────────────────────────────────────────────

/** Un renglón de metadata del SAT (subconjunto que nos importa). */
export interface SatMetadataRow {
  uuid: string;
  /** Columna "Estatus": "1"/"Vigente" = vigente, "0"/"Cancelado" = cancelado. */
  estatus: string;
  fechaCancelacion?: string;
}

/** Estado mínimo de una factura nuestra para decidir la transición. */
export interface InvoiceEstado {
  id: string;
  uuid: string;
  status: string; // InvoiceStatus: DRAFT | STAMPED | CANCELLED
}

export interface CancelacionesResult {
  /** IDs de facturas que pasan de STAMPED a CANCELLED. */
  toCancel: { id: string; uuid: string; fechaCancelacion?: string }[];
  /** Renglones de metadata leídos. */
  vistos: number;
  /** Renglones marcados como cancelados en el SAT. */
  canceladosEnSat: number;
}

/**
 * Meses (incluyendo el actual) que cubre la ventana LEGAL de cancelación.
 *
 * Desde la reforma al CFF de 2022 (Art. 29-A), un CFDI sólo puede cancelarse
 * hasta el mes en que se debe presentar la anual del ejercicio en que se
 * emitió (PM: marzo, PF: abril). Por eso:
 *   • hasta abril: lo emitido desde ENERO DEL EJERCICIO ANTERIOR sigue siendo
 *     cancelable → la ventana crece hasta 16 meses (en abril);
 *   • de mayo en adelante: sólo el ejercicio en curso → 5..12 meses.
 *
 * La ventana fija de 3 meses que sustituye esto tenía un hueco real: una
 * factura de enero cancelada en noviembre jamás se detectaba, porque el
 * periodo de enero ya no se re-consultaba.
 */
export function mesesVentanaCancelable(hoy: Date): number {
  const mes = hoy.getMonth() + 1; // local, igual que la enumeración de periodos del cron
  return mes <= 4 ? 12 + mes : mes;
}

/** Fila mínima de SatSyncRequest FINISHED para decidir el backlog. */
export interface RequestTerminado {
  year: number;
  month: number;
  tipo: string; // EMITIDOS | RECIBIDOS | METADATA_EMITIDOS | METADATA_RECIBIDOS
}

/**
 * Backlog de verificación de cancelaciones, con gate POR MES: un mes es
 * elegible cuando su XML está COMPLETO (EMITIDOS y RECIBIDOS en FINISHED —
 * todas sus facturas ya existen en BD) y su metadata aún no termina (falta
 * algún METADATA_*). Se excluye la ventana rodante (esa la cubre la fase A).
 *
 * El gate anterior era por EMPRESA (esperar el backfill de 5 años completo):
 * una recién onboardeada pasaba DÍAS con historial de cancelaciones vacío
 * aunque sus meses recientes llevaran días importados. Con el gate por mes,
 * el estatus de cancelación va un tick detrás de cada mes importado.
 *
 * Más nuevo primero: la probabilidad de cancelación relevante decae con la
 * antigüedad. Función PURA (la consulta vive en el route).
 */
/**
 * Orden JUSTO de empresas para el barrido de cancelaciones: primero las que
 * NUNCA se han consultado, luego las de consulta más antigua.
 *
 * Por qué importa: el barrido va acotado por tiempo, y recorriendo siempre en
 * el mismo orden las últimas de la lista se quedaban sin turno para siempre —
 * justo el caso de una empresa recién onboardeada, cuyo historial completo
 * depende de esa fase. Con este orden, la empresa nueva es la PRIMERA.
 *
 * PURA: recibe la última consulta por empresa (null = nunca) y devuelve los
 * ids ordenados. Empate → por id, para que el recorrido sea determinista.
 */
export function ordenEmpresasPorAntiguedad<T extends { id: string }>(
  empresas: T[],
  ultimaConsulta: Map<string, Date | null>,
): T[] {
  return [...empresas].sort((a, b) => {
    const ta = ultimaConsulta.get(a.id) ?? null;
    const tb = ultimaConsulta.get(b.id) ?? null;
    if (ta === null && tb !== null) return -1;
    if (tb === null && ta !== null) return 1;
    if (ta !== null && tb !== null && ta.getTime() !== tb.getTime()) {
      return ta.getTime() - tb.getTime();
    }
    return a.id.localeCompare(b.id);
  });
}

export function mesesBacklogCancelaciones(
  terminados: RequestTerminado[],
  ventanaRodante: Array<{ year: number; month: number }>,
): Array<{ year: number; month: number }> {
  const porMes = new Map<string, Set<string>>();
  for (const t of terminados) {
    const k = `${t.year}-${t.month}`;
    const s = porMes.get(k) ?? new Set<string>();
    s.add(t.tipo);
    porMes.set(k, s);
  }
  const excluir = new Set(ventanaRodante.map((p) => `${p.year}-${p.month}`));

  const out: Array<{ year: number; month: number }> = [];
  for (const [k, tipos] of porMes) {
    if (excluir.has(k)) continue;
    const xmlCompleto = tipos.has("EMITIDOS") && tipos.has("RECIBIDOS");
    const metaCompleta = tipos.has("METADATA_EMITIDOS") && tipos.has("METADATA_RECIBIDOS");
    if (!xmlCompleto || metaCompleta) continue;
    const [year, month] = k.split("-").map(Number);
    out.push({ year, month });
  }
  return out.sort((a, b) => b.year - a.year || b.month - a.month);
}

/** True si el estatus del SAT indica cancelado. Robusto a "0" o texto "Cancelado". */
export function esEstatusCancelado(estatus: string | null | undefined): boolean {
  if (estatus == null) return false;
  const v = estatus.trim().toLowerCase();
  if (v === "") return false;
  // SAT usa "0" = cancelado, "1" = vigente; algunos export traen texto.
  return v === "0" || v.startsWith("cancel");
}

/**
 * Decide qué facturas cancelar: sólo las que TENEMOS como STAMPED y que el SAT
 * reporta canceladas. No tocamos DRAFT (aún no son válidas) ni las ya CANCELLED
 * (idempotente), ni UUIDs que no conocemos (no creamos nada desde metadata).
 */
export function interpretarCancelaciones(
  rows: SatMetadataRow[],
  owned: InvoiceEstado[]
): CancelacionesResult {
  const byUuid = new Map<string, InvoiceEstado>();
  for (const inv of owned) {
    if (inv.uuid) byUuid.set(inv.uuid.toUpperCase(), inv);
  }

  const toCancel: CancelacionesResult["toCancel"] = [];
  let canceladosEnSat = 0;
  const yaVistos = new Set<string>();

  for (const row of rows) {
    const uuid = row.uuid?.trim().toUpperCase();
    if (!uuid || yaVistos.has(uuid)) continue;
    yaVistos.add(uuid);
    if (!esEstatusCancelado(row.estatus)) continue;
    canceladosEnSat++;
    const inv = byUuid.get(uuid);
    if (inv && inv.status === "STAMPED") {
      toCancel.push({ id: inv.id, uuid, fechaCancelacion: row.fechaCancelacion });
    }
  }

  return { toCancel, vistos: yaVistos.size, canceladosEnSat };
}
