// ─────────────────────────────────────────────────────────────────────────────
// Adapter: real Invoice rows → CfdiNormalizado. Structurally typed (no
// @prisma/client import) so the auditor core stays decoupled from the evolving
// schema. `direccion` is supplied by the caller — the app already derives
// emitida/recibida from the company RFC vs. the CFDI's emisor/receptor, so we
// don't re-invent that heuristic here.
// ─────────────────────────────────────────────────────────────────────────────

import type { CfdiNormalizado, Direccion } from "./types";

export interface InvoiceItemLike {
  claveProdServ: string;
  descripcion?: string | null;
}

export interface InvoiceLike {
  id: string;
  fecha: Date | string;
  formaPago: string;
  total: number;
  items: InvoiceItemLike[];
}

function toIso(fecha: Date | string): string {
  const d = typeof fecha === "string" ? new Date(fecha) : fecha;
  return d.toISOString().slice(0, 10);
}

export function toCfdiNormalizado(
  inv: InvoiceLike,
  direccion: Direccion,
  opts?: { ivaTrasladado?: number },
): CfdiNormalizado {
  return {
    id: inv.id,
    direccion,
    fecha: toIso(inv.fecha),
    formaPago: inv.formaPago,
    total: inv.total,
    items: inv.items.map((i) => ({
      claveProdServ: i.claveProdServ,
      descripcion: i.descripcion ?? undefined,
    })),
    ivaTrasladado: opts?.ivaTrasladado,
  };
}
