// ─────────────────────────────────────────────────────────────────────────────
// 69-B / EFOS — empresas que facturan operaciones simuladas (Art. 69-B CFF).
// El SAT publica el "Listado completo" de contribuyentes con operaciones
// presuntas/definitivas. Deducir o acreditar IVA de CFDIs emitidos por un EFOS
// DEFINITIVO es improcedente; PRESUNTO es riesgo. Este módulo modela la lista y
// la revisión; la descarga/caché del CSV del SAT va detrás (fetch — sigue).
// ─────────────────────────────────────────────────────────────────────────────

export type SituacionEfos =
  | "PRESUNTO"
  | "DEFINITIVO"
  | "DESVIRTUADO"
  | "SENTENCIA_FAVORABLE";

/** RFC del emisor → su situación 69-B vigente. */
export type ListaEfos = Map<string, SituacionEfos>;

/** Las situaciones que implican riesgo fiscal para quien dedujo. */
export const SITUACIONES_RIESGO: SituacionEfos[] = ["DEFINITIVO", "PRESUNTO"];

/** CFDI recibido mínimo para la revisión 69-B. */
export interface CfdiProveedor {
  id: string;
  /** RFC del emisor (proveedor). */
  emisorRfc: string;
  fecha: string; // ISO
  total: number;
}

export type RolRfc = "PROPIO" | "CONTRAPARTE";

/** Un RFC a cotejar contra la lista (empresa propia, cliente o proveedor). */
export interface RfcEntrada {
  rfc: string;
  rol: RolRfc;
  nombre?: string;
}
