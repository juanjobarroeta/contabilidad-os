// ─────────────────────────────────────────────────────────────────────────────
// Normalized Facturapi error handling.
//
// The Facturapi Node SDK throws errors of varying shape: axios errors with
// `.response.data.message`, plain Error objects, sometimes strings. This
// helper turns all of them into a stable envelope so API routes can surface
// something useful to the user AND the UI can tell when the key is dead and
// offer a "Reconfigurar" button.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";

export type FacturapiErrorKind =
  | "auth"         // 401/403 — key dead or permission denied
  | "validation"   // 400/422 — the CFDI/customer data is wrong
  | "not_found"    // 404
  | "rate_limit"   // 429
  | "server"       // 5xx from Facturapi
  | "unknown";

export type FacturapiErrorInfo = {
  kind: FacturapiErrorKind;
  status: number;         // HTTP status we'll return
  message: string;        // Spanish user-facing message
  rawMessage: string;     // Original Facturapi message
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  details: any;           // Full Facturapi response body for logs
  needsReconfigure: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseFacturapiError(e: any): FacturapiErrorInfo {
  const status = e?.response?.status ?? e?.status ?? 0;
  const data = e?.response?.data ?? null;
  const raw =
    (typeof data === "string" && data) ||
    data?.message ||
    e?.message ||
    "Error desconocido";

  // 401 / 403 → key is dead or missing permissions. These unblock only by
  // re-provisioning Facturapi.
  if (status === 401 || status === 403) {
    return {
      kind: "auth",
      status: 422,
      message: "La clave de Facturapi ya no es válida. Reconfigura Facturapi en Mi Empresa.",
      rawMessage: raw,
      details: data,
      needsReconfigure: true,
    };
  }

  // 404 → usually "customer not found in Facturapi" — common after org re-link
  if (status === 404) {
    return {
      kind: "not_found",
      status: 422,
      message: `No encontrado en Facturapi: ${raw}. Vuelve a sincronizar el cliente.`,
      rawMessage: raw,
      details: data,
      needsReconfigure: false,
    };
  }

  // 400 / 422 → validation (wrong régimen, wrong claveProdServ, etc.)
  if (status === 400 || status === 422) {
    return {
      kind: "validation",
      status: 422,
      message: `Facturapi rechazó los datos: ${raw}`,
      rawMessage: raw,
      details: data,
      needsReconfigure: false,
    };
  }

  // 429 → rate limited
  if (status === 429) {
    return {
      kind: "rate_limit",
      status: 429,
      message: "Demasiadas solicitudes a Facturapi. Espera un momento y vuelve a intentar.",
      rawMessage: raw,
      details: data,
      needsReconfigure: false,
    };
  }

  // 5xx → Facturapi is down
  if (status >= 500 && status < 600) {
    return {
      kind: "server",
      status: 502,
      message: "Facturapi está temporalmente fuera de servicio. Intenta en unos minutos.",
      rawMessage: raw,
      details: data,
      needsReconfigure: false,
    };
  }

  // Anything else
  return {
    kind: "unknown",
    status: 500,
    message: `Error inesperado en Facturapi: ${raw}`,
    rawMessage: raw,
    details: data,
    needsReconfigure: false,
  };
}

/**
 * Wraps a Facturapi call and returns a NextResponse if it fails, or the
 * successful result if it doesn't. Usage:
 *
 *   const customer = await withFacturapi(
 *     () => client.customers.create(data),
 *     "crear cliente"
 *   );
 *   if (customer instanceof NextResponse) return customer;
 *   // use customer
 */
export async function withFacturapi<T>(
  op: () => Promise<T>,
  context: string
): Promise<T | NextResponse> {
  try {
    return await op();
  } catch (e) {
    const info = parseFacturapiError(e);
    console.error(`[facturapi:${context}]`, {
      kind: info.kind,
      status: info.status,
      raw: info.rawMessage,
      details: info.details,
    });
    return NextResponse.json(
      {
        error: info.message,
        kind: info.kind,
        needsReconfigure: info.needsReconfigure,
        details: info.details,
      },
      { status: info.status }
    );
  }
}
