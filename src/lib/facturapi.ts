import Facturapi from "facturapi";
import { Readable } from "stream";
import { prisma } from "./prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Master client — uses the user-level (sk_user_/sk_live_) key from Facturapi.
// This is the SaaS reseller key with permission to create + manage organizations.
// Falls back to the legacy FACTURAPI_SECRET_KEY env var name if MASTER not set.
// ─────────────────────────────────────────────────────────────────────────────
function getMasterKey(): string | null {
  const k = process.env.FACTURAPI_MASTER_KEY ?? process.env.FACTURAPI_SECRET_KEY;
  if (!k || k === "sk_test_" || k.trim() === "") return null;
  return k;
}

let _admin: Facturapi | null = null;
function getAdminClient(): Facturapi {
  const key = getMasterKey();
  if (!key) {
    throw new Error(
      "FACTURAPI_MASTER_KEY no está configurada en las variables de entorno"
    );
  }
  if (!_admin) _admin = new Facturapi(key);
  return _admin;
}

// Backwards-compat export — many existing routes import `facturapiAdmin`.
// New code should call getAdminClient() directly so init can fail loudly.
export const facturapiAdmin = new Proxy({} as Facturapi, {
  get(_target, prop) {
    const client = getAdminClient();
    return Reflect.get(client, prop);
  },
});

// Per-company Facturapi client using the company's own org-scoped API key
export function getFacturapiClient(companyApiKey: string) {
  return new Facturapi(companyApiKey);
}

// ─────────────────────────────────────────────────────────────────────────────
// Provisioning helper — single source of truth for "set up Facturapi for a
// company". Idempotent: safe to call multiple times. Used by:
//   - POST /api/companies (auto on create)
//   - PATCH /api/companies/[id] when CSD/FIEL are uploaded
//   - POST /api/companies/[id]/facturapi (manual retry)
//   - prisma/scripts/backfill-facturapi.ts (one-time backfill)
// ─────────────────────────────────────────────────────────────────────────────

export type ProvisionResult = {
  ok: boolean;
  orgId: string | null;
  csdUploaded: boolean;
  hasLiveKey: boolean;
  warning?: string;
  error?: string;
};

function base64ToStream(base64: string): NodeJS.ReadableStream {
  const buffer = Buffer.from(base64, "base64");
  const readable = new Readable();
  readable.push(buffer);
  readable.push(null);
  return readable;
}

/**
 * Provisions a company on Facturapi:
 *   1. Creates an organization if one doesn't exist (stores facturapiOrgId)
 *   2. Updates legal info (RFC, razón social, régimen, CP)
 *   3. If CSD is present in DB, uploads it to Facturapi
 *   4. If CSD upload succeeded, generates a live API key (renewLiveApiKey)
 *      and stores it as company.facturapiApiKey
 *
 * Errors are caught and returned in the result — never thrown — so callers
 * can decide whether to surface them. Company creation MUST NOT fail just
 * because Facturapi is down.
 */
export async function provisionFacturapiOrg(companyId: string): Promise<ProvisionResult> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
  });
  if (!company) {
    return { ok: false, orgId: null, csdUploaded: false, hasLiveKey: false, error: "Empresa no encontrada" };
  }

  // Skip silently if no master key — keeps local dev working without Facturapi
  if (!getMasterKey()) {
    return {
      ok: false,
      orgId: company.facturapiOrgId,
      csdUploaded: false,
      hasLiveKey: !!company.facturapiApiKey,
      warning: "FACTURAPI_MASTER_KEY no configurada — paso omitido",
    };
  }

  let admin: Facturapi;
  try {
    admin = getAdminClient();
  } catch (e) {
    return {
      ok: false,
      orgId: company.facturapiOrgId,
      csdUploaded: false,
      hasLiveKey: false,
      error: e instanceof Error ? e.message : "No se pudo inicializar Facturapi",
    };
  }

  let orgId = company.facturapiOrgId;
  let csdUploaded = false;
  let hasLiveKey = !!company.facturapiApiKey;
  let liveKey: string | null = null;
  let warning: string | undefined;

  try {
    // 1. Create org if needed
    if (!orgId) {
      const org = await admin.organizations.create({ name: company.razonSocial });
      orgId = org.id;
    }

    // 2. Update legal info — idempotent.
    // Facturapi v2 note: `tax_id` (RFC) is NOT accepted here — it's inferred
    // from the CSD certificate when uploaded. `name` is the display name,
    // `legal_name` is the razón social used on CFDIs.
    await admin.organizations.updateLegal(orgId, {
      name: company.nombreComercial || company.razonSocial,
      legal_name: company.razonSocial,
      tax_system: company.regimenFiscal,
      address: {
        zip: company.codigoPostal,
        ...(company.domicilioFiscal ? { street: company.domicilioFiscal } : {}),
      },
    });

    // 3. Upload CSD if present and we don't already have a live key
    //    (we don't re-upload on every call to avoid wasting their API quota)
    if (
      !hasLiveKey &&
      company.csdCer &&
      company.csdKey &&
      company.csdPassword
    ) {
      try {
        await admin.organizations.uploadCertificate(
          orgId,
          base64ToStream(company.csdCer),
          base64ToStream(company.csdKey),
          company.csdPassword
        );
        csdUploaded = true;

        // 4. Generate the live key. NOTE: this invalidates any prior live key.
        const result = await admin.organizations.renewLiveApiKey(orgId);
        // Facturapi SDK returns { ok, key } or similar — handle both shapes
        const r = result as unknown as { key?: string; api_key?: string };
        liveKey = r.key ?? r.api_key ?? null;
        if (liveKey) hasLiveKey = true;
      } catch (e) {
        warning = `Org creada pero falló el CSD/llave live: ${
          e instanceof Error ? e.message : "error desconocido"
        }`;
      }
    } else if (!hasLiveKey && (!company.csdCer || !company.csdKey || !company.csdPassword)) {
      warning = "Org creada. Sube el CSD para emitir CFDIs en producción.";
    }

    // 5. Persist whatever changed
    await prisma.company.update({
      where: { id: companyId },
      data: {
        facturapiOrgId: orgId,
        ...(liveKey ? { facturapiApiKey: liveKey } : {}),
      },
    });

    return { ok: true, orgId, csdUploaded, hasLiveKey, warning };
  } catch (e) {
    return {
      ok: false,
      orgId,
      csdUploaded,
      hasLiveKey,
      error: e instanceof Error ? e.message : "Error desconocido en Facturapi",
    };
  }
}
