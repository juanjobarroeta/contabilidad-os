// ─────────────────────────────────────────────────────────────────────────────
// SwSapienPacProvider — implementación de PacProvider sobre SW sapien (sw.com.mx).
//
// Alternativa a Facturapi para timbrar más barato a volumen, con onboarding
// self-service (a diferencia de Finkok). Se selecciona con PAC_PROVIDER=swsapien.
//
// ⚠️ ESTADO: ANDAMIO VERIFICABLE, NO ACTIVO POR DEFECTO.
// SW emite por JSON (SW guarda el CSD del emisor) y cancela con CSD. El timbrado
// es un acto fiscal/legal: NO se debe emitir con mapeos a ciegas. Por eso:
//   • Todo método exige credenciales SW (env). Sin ellas devuelve un PacOutcome
//     `needsReconfigure` claro — nunca un CFDI mal formado.
//   • Los pocos campos que dependen del formato exacto de la cuenta SW están
//     marcados con TODO(sw): confírmalos con un timbre de prueba en sandbox
//     antes de poner PAC_PROVIDER=swsapien en producción.
// Endpoints según la API v4 pública de SW (services.sw.com.mx). Ajusta si tu
// contrato usa otra base/rutas.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  CfdiInput,
  OrgProvisionResult,
  PacErrorKind,
  PacOutcome,
  PacProvider,
  StampedCfdi,
} from "./types";

const SW_BASE = (process.env.SW_BASE_URL ?? "https://services.sw.com.mx").replace(/\/$/, "");

/** ¿Hay credenciales SW configuradas? (token persistente o user/password). */
function swConfigured(): boolean {
  return !!(process.env.SW_TOKEN || (process.env.SW_USER && process.env.SW_PASSWORD));
}

function noConfigurado(): Extract<PacOutcome<never>, { ok: false }> {
  return {
    ok: false,
    status: 422,
    message:
      "SW sapien no está configurado. Define SW_TOKEN (o SW_USER/SW_PASSWORD) y verifica un timbre de prueba en sandbox antes de activarlo.",
    kind: "auth",
    needsReconfigure: true,
  };
}

function fail(status: number, message: string, kind: PacErrorKind = "unknown"): Extract<PacOutcome<never>, { ok: false }> {
  return { ok: false, status, message, kind, needsReconfigure: kind === "auth" };
}

// Cache simple del Bearer token (los JWT de SW duran horas). new Date() es válido
// aquí (ruta server), no en workflows.
let tokenCache: { token: string; exp: number } | null = null;

async function getToken(): Promise<string | null> {
  if (process.env.SW_TOKEN) return process.env.SW_TOKEN;
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const user = process.env.SW_USER;
  const password = process.env.SW_PASSWORD;
  if (!user || !password) return null;
  try {
    const res = await fetch(`${SW_BASE}/v2/security/authenticate`, {
      method: "POST",
      headers: { user, password },
    });
    const json = (await res.json()) as { data?: { token?: string } };
    const token = json?.data?.token;
    if (!token) return null;
    // JWT ~ 4h; cacheamos 3h por conservadurismo.
    tokenCache = { token, exp: Date.now() + 3 * 60 * 60 * 1000 };
    return token;
  } catch {
    return null;
  }
}

// Mapea CfdiInput → plantilla JSON CFDI 4.0 de SW (emisión "issue").
// SW pone al receptor en línea (no hay catálogo de clientes como Facturapi), por
// eso para SW `customerRef` se interpreta como el RFC del receptor.
// TODO(sw): el receptor completo (nombre, régimen, uso, CP) debe llegar aquí; hoy
// la interfaz sólo trae customerRef → falta enriquecer CfdiInput o resolver el
// Customer en el call site antes de activar SW.
function buildIssueTemplate(input: CfdiInput): Record<string, unknown> {
  return {
    Receptor: {
      Rfc: input.customerRef, // TODO(sw): mapear a RFC real del receptor
      UsoCFDI: input.use,
      // TODO(sw): Nombre, DomicilioFiscalReceptor (CP), RegimenFiscalReceptor
    },
    FormaPago: input.paymentForm,
    MetodoPago: input.paymentMethod,
    Moneda: "MXN",
    Conceptos: input.items.map((it) => ({
      ClaveProdServ: it.product.product_key,
      ClaveUnidad: it.product.unit_key ?? "E48",
      Cantidad: it.quantity,
      Descripcion: it.product.description,
      ValorUnitario: it.product.price,
      ObjetoImp: "02",
      // TODO(sw): nodo Impuestos por concepto a partir de it.product.taxes
    })),
    // TODO(sw): Información Global (input.global) para CFDI al Público en General
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toStamped(d: any): StampedCfdi {
  return {
    pacId: d?.uuid ?? d?.id ?? "",
    uuid: d?.uuid ?? null,
    total: typeof d?.total === "number" ? d.total : undefined,
    subtotal: typeof d?.subtotal === "number" ? d.subtotal : undefined,
    folio: d?.folio ?? null,
  };
}

export const swSapienPacProvider: PacProvider = {
  name: "swsapien",

  async createCfdi(_apiKey, input): Promise<PacOutcome<StampedCfdi>> {
    if (!swConfigured()) return noConfigurado();
    const token = await getToken();
    if (!token) return fail(401, "No se pudo autenticar con SW sapien.", "auth");
    try {
      const res = await fetch(`${SW_BASE}/v4/cfdi40/issue/json`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildIssueTemplate(input)),
      });
      const json = (await res.json()) as { status?: string; data?: unknown; message?: string };
      if (!res.ok || json?.status === "error") {
        return fail(res.status || 422, json?.message ?? "Error de SW al timbrar.", res.status === 401 ? "auth" : "validation");
      }
      return { ok: true, data: toStamped(json.data) };
    } catch (e) {
      return fail(503, e instanceof Error ? e.message : "SW no disponible.", "server");
    }
  },

  // SW no tiene borradores en servidor (flujo issue). Emulamos: el "borrador" es
  // el propio input codificado; stampDraft lo emite. discardDraft es no-op.
  async createDraft(_apiKey, input): Promise<PacOutcome<{ draftId: string }>> {
    if (!swConfigured()) return noConfigurado();
    const draftId = Buffer.from(JSON.stringify(input), "utf-8").toString("base64");
    return { ok: true, data: { draftId } };
  },

  async stampDraft(apiKey, draftId): Promise<PacOutcome<StampedCfdi>> {
    if (!swConfigured()) return noConfigurado();
    let input: CfdiInput;
    try {
      input = JSON.parse(Buffer.from(draftId, "base64").toString("utf-8")) as CfdiInput;
    } catch {
      return fail(400, "Borrador SW inválido.", "validation");
    }
    return this.createCfdi(apiKey, input);
  },

  async discardDraft(): Promise<void> {
    // No-op: el borrador de SW es local (no consume recursos del PAC).
  },

  async cancelCfdi(_apiKey, pacId, motivo, sustituyeUuid): Promise<PacOutcome<void>> {
    if (!swConfigured()) return noConfigurado();
    const token = await getToken();
    if (!token) return fail(401, "No se pudo autenticar con SW sapien.", "auth");
    try {
      // TODO(sw): confirmar ruta/payload de cancelación con tu cuenta (issue-cancel
      // usa el CSD que SW resguarda). uuid + motivo (+ folioSustitucion si motivo 01).
      const res = await fetch(`${SW_BASE}/v4/cfdi/cancel/issue`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ uuid: pacId, motivo, ...(sustituyeUuid ? { folioSustitucion: sustituyeUuid } : {}) }),
      });
      const json = (await res.json()) as { status?: string; message?: string };
      if (!res.ok || json?.status === "error") {
        return fail(res.status || 422, json?.message ?? "Error de SW al cancelar.", res.status === 401 ? "auth" : "validation");
      }
      return { ok: true, data: undefined };
    } catch (e) {
      return fail(503, e instanceof Error ? e.message : "SW no disponible.", "server");
    }
  },

  async provisionOrg(): Promise<OrgProvisionResult> {
    // SW resguarda el CSD del emisor; la carga del CSD se hace en el portal de SW
    // (o su API de administración de CSD). TODO(sw): automatizar si se requiere.
    return {
      ok: false,
      orgId: null,
      csdUploaded: false,
      hasLiveKey: false,
      error: "Carga el CSD del emisor en el portal de SW sapien; el provisioning automático no está implementado.",
    };
  },
};
