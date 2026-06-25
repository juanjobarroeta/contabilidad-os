import type { StampInput, StampResult, DraftResult } from "@/lib/facturas/stamp";

// ─────────────────────────────────────────────────────────────────────────────
// Finkok PAC adapter — raw-XML timbrado.
//
// Unlike Facturapi (which computes + seals the CFDI server-side), Finkok stamps
// an XML that WE build and seal in-house. That's the whole point: it lets us
// emit TRUNCATED taxes (see lib/pac/index.ts) that match the prefactura to the
// cent, which Gobernación requires.
//
// Pipeline (Phase 2 — not yet implemented):
//   1. Build the CFDI 4.0 XML from StampInput, using our floor2() truncation for
//      IVA/retención instead of letting a PAC round.
//   2. Seal it with the company CSD (csdCer/csdKey/csdPassword, decrypted via
//      lib/crypto) using @nodecfdi/credentials → cadena original + sello.
//   3. POST the sealed XML to Finkok's stamp WS (sandbox first), which adds the
//      TimbreFiscalDigital and returns the timbred XML + UUID.
//   4. Persist as a local INGRESO Invoice (same shape as the Facturapi path).
//
// Credentials: Finkok account (username + reseller key) come from env
//   FINKOK_USERNAME / FINKOK_PASSWORD / FINKOK_ENV ("sandbox" | "production").
// The CSD is per-company (already stored encrypted on Company).
// ─────────────────────────────────────────────────────────────────────────────

const NOT_IMPLEMENTED =
  "El timbrado con Finkok aún no está disponible (en implementación). " +
  "Este cliente está marcado para Finkok pero el adaptador no se ha completado.";

/** Stamp a CFDI through Finkok. Phase 2 will implement build → seal → stamp. */
export async function finkokStampInvoice(_input: StampInput): Promise<StampResult> {
  // TODO(Phase 2): build CFDI 4.0 XML (truncated taxes) → seal with CSD via
  // @nodecfdi/credentials → POST to Finkok stamp WS → persistStampedInvoice.
  return { ok: false, status: 501, error: NOT_IMPLEMENTED };
}

/**
 * Draft/preview for Finkok customers. Finkok has no server-side "draft" concept
 * like Facturapi; Phase 2 will render the preview from the locally-built XML
 * (the prefactura already shows the truncated totals, so this is mostly a SAT
 * classification preview).
 */
export async function finkokCreateDraft(_input: StampInput): Promise<DraftResult> {
  // TODO(Phase 2): build the XML and surface a borrador preview without timbre.
  return { ok: false, status: 501, error: NOT_IMPLEMENTED };
}

/** Cancel a Finkok-stamped CFDI at SAT (motivo 01–04). Phase 2/3. */
export async function finkokCancelCfdi(_args: {
  uuid: string;
  motivo: string;
  sustituyeUuid?: string;
  companyId: string;
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  // TODO(Phase 2/3): call Finkok cancel WS, signed with the company CSD.
  return { ok: false, status: 501, error: NOT_IMPLEMENTED };
}
