/**
 * Facturapi en MODO TEST para la empresa demo (ALTIPLANO) — y sólo para ella.
 *
 * Las llaves de Facturapi viven POR EMPRESA, así que la demo puede timbrar en
 * sandbox (sk_test_…: timbres gratis, sin SAT, PDF con marca de prueba)
 * mientras todas las demás empresas siguen en vivo. Con esto la demo puede
 * ENSEÑAR el timbrado real: prefacturas, Timbrar y el flujo de REP.
 *
 * Idempotente: reusa la org si ya existe y re-lee la llave test. Al final
 * sincroniza los clientes de la demo (todos nacen con CP desde el seed).
 *
 * Uso (contra el entorno deseado):
 *   DATABASE_URL=<url> CREDENTIALS_ENCRYPTION_KEY=<la del entorno> \
 *   FACTURAPI_MASTER_KEY=<sk_user_…> npx tsx scripts/facturapi-demo-test.ts
 */

import Facturapi from "facturapi";
import { prisma } from "../src/lib/prisma";
import { encryptSecret } from "../src/lib/crypto";
import { ensureFacturapiCustomer } from "../src/lib/facturapi";
import { sinRegimenSocietario } from "../src/lib/fiscal/nombre-fiscal";

const DEMO_RFC = "CAL150612DM4";

async function main() {
  const masterKey = process.env.FACTURAPI_MASTER_KEY;
  if (!masterKey) throw new Error("Falta FACTURAPI_MASTER_KEY");
  const admin = new Facturapi(masterKey);

  const company = await prisma.company.findFirstOrThrow({
    where: { rfc: DEMO_RFC },
    select: { id: true, razonSocial: true, regimenFiscal: true, codigoPostal: true, facturapiOrgId: true },
  });

  let orgId = company.facturapiOrgId;
  if (!orgId) {
    const org = await admin.organizations.create({ name: `${company.razonSocial} (DEMO)` });
    orgId = org.id as string;
    console.log("· Org creada:", orgId);
  } else {
    console.log("· Org existente:", orgId);
  }

  await admin.organizations.updateLegal(orgId, {
    name: company.razonSocial,
    legal_name: sinRegimenSocietario(company.razonSocial),
    tax_system: company.regimenFiscal,
    address: { zip: company.codigoPostal ?? "72810" },
  });

  // Llave TEST (sandbox). Mismo manejo de formas que la live en el provisioner.
  const raw = await admin.organizations.getTestApiKey(orgId);
  const testKey =
    typeof raw === "string" ? raw : ((raw as { key?: string; api_key?: string })?.key ?? (raw as { api_key?: string })?.api_key ?? null);
  if (!testKey || !testKey.startsWith("sk_test")) {
    throw new Error(`Llave test inesperada: ${String(testKey).slice(0, 12)}…`);
  }

  const encrypted = encryptSecret(testKey);
  await prisma.company.update({
    where: { id: company.id },
    data: { facturapiOrgId: orgId, facturapiApiKey: encrypted },
  });
  console.log("· Llave TEST guardada (cifrada) en la empresa demo.");

  const clientes = await prisma.customer.findMany({ where: { companyId: company.id } });
  for (const c of clientes) {
    const r = await ensureFacturapiCustomer(encrypted, c);
    console.log(`  · ${c.razonSocial}: ${r.ok ? "sincronizado" : r.error}`);
  }
  console.log("✔ ALTIPLANO en modo test — Timbrar/prefacturas/REP funcionan en sandbox.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
