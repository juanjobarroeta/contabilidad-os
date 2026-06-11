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
