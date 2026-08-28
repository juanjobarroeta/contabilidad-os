import Facturapi from "facturapi";
import { Readable } from "stream";
import { prisma } from "./prisma";
import { decryptSecret, encryptSecret } from "./crypto";
import { emisorNombreDesdeXml, sinRegimenSocietario } from "./fiscal/nombre-fiscal";

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

// Per-company Facturapi client using the company's own org-scoped API key.
// The key is stored encrypted at rest; decrypt here so all callers can pass the
// raw stored value (legacy plaintext passes through unchanged).
export function getFacturapiClient(companyApiKey: string) {
  return new Facturapi(decryptSecret(companyApiKey));
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

/**
 * Nombre EXACTO del padrón del SAT para el RFC de la empresa, rescatado del
 * nodo Emisor de sus CFDIs timbrados guardados (un CFDI timbrado ya pasó la
 * validación de nombre del SAT). Se revisan algunos candidatos porque la
 * empresa también guarda CFDIs RECIBIDOS (emisor = un tercero) — el helper
 * verifica el RFC y aquí nos quedamos con el primero que cuadre.
 */
async function nombreEmisorDesdeCfdisTimbrados(
  companyId: string,
  rfc: string
): Promise<string | null> {
  const candidatos = await prisma.invoice.findMany({
    where: { companyId, status: "STAMPED", rawXml: { not: null } },
    orderBy: { fecha: "desc" },
    take: 10,
    select: { rawXml: true },
  });
  for (const c of candidatos) {
    const nombre = c.rawXml ? emisorNombreDesdeXml(c.rawXml, rfc) : null;
    if (nombre) return nombre;
  }
  return null;
}

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
    // `legal_name` es el Nombre del EMISOR en los CFDIs y el SAT lo valida
    // contra el padrón: debe ser EXACTO y SIN régimen societario (CFDI 4.0 —
    // "El campo Nombre del emisor, debe pertenecer al nombre asociado al RFC").
    // Se rescata del nodo Emisor de un CFDI ya timbrado de este RFC (los
    // importados del SAT traen el nombre exacto del padrón); sin historial,
    // se recorta el sufijo societario de la razón social capturada.
    const legalName =
      (await nombreEmisorDesdeCfdisTimbrados(company.id, company.rfc)) ??
      sinRegimenSocietario(company.razonSocial);
    await admin.organizations.updateLegal(orgId, {
      name: company.nombreComercial || company.razonSocial,
      legal_name: legalName,
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
          base64ToStream(decryptSecret(company.csdCer)),
          base64ToStream(decryptSecret(company.csdKey)),
          decryptSecret(company.csdPassword)
        );
        csdUploaded = true;

        // 4. Generate the live key. NOTE: this invalidates any prior live key,
        // so we MUST persist whatever we get back.
        // The Facturapi SDK returns the key in different shapes depending on
        // version: sometimes a plain string ("sk_live_..."), sometimes an
        // object { key: "sk_live_..." } or { api_key: "..." }. Handle all.
        const result = await admin.organizations.renewLiveApiKey(orgId);
        if (typeof result === "string") {
          liveKey = result;
        } else if (result && typeof result === "object") {
          const r = result as { key?: string; api_key?: string };
          liveKey = r.key ?? r.api_key ?? null;
        }
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
        ...(liveKey ? { facturapiApiKey: encryptSecret(liveKey) } : {}),
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

// ─────────────────────────────────────────────────────────────────────────────
// Sync perezoso de clientes: garantiza que el cliente exista en Facturapi EN
// EL MOMENTO de timbrar. El sync al crear sólo ocurría si la llave ya estaba
// configurada y el cliente traía CP: cualquier cliente capturado antes de
// conectar Facturapi, importado del SAT o sin CP quedaba en «no está
// sincronizado con Facturapi» — un callejón sin salida sin arreglo en la UI
// (reporte del owner). Aquí se sincroniza cuando de verdad se necesita y se
// persiste el id; el error, cuando lo hay, dice QUÉ falta.
// ─────────────────────────────────────────────────────────────────────────────
export async function ensureFacturapiCustomer(
  facturapiApiKey: string,
  customer: {
    id: string;
    facturapiId: string | null;
    razonSocial: string;
    rfc: string;
    regimenFiscal: string;
    email: string | null;
    phone: string | null;
    domicilio: string | null;
    codigoPostal: string | null;
  },
): Promise<{ ok: true; facturapiId: string } | { ok: false; error: string }> {
  if (customer.facturapiId) return { ok: true, facturapiId: customer.facturapiId };
  if (!customer.codigoPostal) {
    return {
      ok: false,
      error: `Falta el código postal fiscal de ${customer.razonSocial}. Captúralo en Directorio → editar cliente: el SAT valida RFC + nombre + CP al timbrar.`,
    };
  }
  try {
    const fp = getFacturapiClient(facturapiApiKey);
    const fpCustomer = await fp.customers.create({
      // CFDI 4.0: el nombre se valida contra el padrón SIN régimen societario.
      legal_name: sinRegimenSocietario(customer.razonSocial),
      tax_id: customer.rfc.toUpperCase(),
      tax_system: customer.regimenFiscal,
      email: customer.email || undefined,
      phone: customer.phone || undefined,
      address: { zip: customer.codigoPostal, street: customer.domicilio || undefined },
    });
    await prisma.customer.update({
      where: { id: customer.id },
      data: { facturapiId: fpCustomer.id },
    });
    return { ok: true, facturapiId: fpCustomer.id };
  } catch (e) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = e as any;
    const detalle = err?.response?.data?.message ?? err?.message ?? "error desconocido";
    return { ok: false, error: `No se pudo registrar el cliente en Facturapi: ${detalle}` };
  }
}
