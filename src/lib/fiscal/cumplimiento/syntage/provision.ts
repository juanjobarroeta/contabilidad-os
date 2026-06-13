// ─────────────────────────────────────────────────────────────────────────────
// Aprovisionamiento Syntage: por cada empresa con e.firma guardada, asegura su
// entidad + credencial (e.firma) y dispara extracciones frescas (sin esperar).
// Idempotente: reutiliza entidad/credencial existentes. El resultado se lee
// luego con el cron de sync. Para no esperar (timeout del proxy), NO valida la
// credencial aquí — Syntage la valida async y la extracción espera a que esté.
//
// provisionAllCompanies precarga las listas de entidades y credenciales UNA vez
// y hace el match localmente, en vez de listar por empresa (cuota + latencia).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { SyntageClient } from "./client";

type Json = Record<string, unknown>;

export interface ProvisionResult {
  companyId: string;
  rfc?: string;
  entityId?: string;
  credencial?: "valida" | "creada";
  skipped?: boolean;
  error?: string;
}

function matchEntityId(entities: Json[], rfc: string): string | null {
  const t = rfc.toUpperCase();
  const m = entities.find((e) => JSON.stringify(e).toUpperCase().includes(t));
  return m ? String(m.id ?? "") || null : null;
}
function hasValidCredential(creds: Json[], rfc: string): boolean {
  return creds.some(
    (c) => String(c.rfc ?? "").toUpperCase() === rfc.toUpperCase() && String(c.status) === "valid",
  );
}

interface FielCompany {
  id: string;
  rfc: string;
  razonSocial: string;
  fielCer: string;
  fielKey: string;
  fielPassword: string;
}

async function provisionOne(
  client: SyntageClient,
  c: FielCompany,
  entities: Json[],
  creds: Json[],
): Promise<ProvisionResult> {
  const type = c.rfc.trim().length === 12 ? "company" : "person";
  const entityId =
    matchEntityId(entities, c.rfc) ??
    (await client.createEntity({ name: c.razonSocial, type, rfc: c.rfc })).id;

  let credencial: "valida" | "creada" = "valida";
  if (!hasValidCredential(creds, c.rfc)) {
    await client.createEfirmaCredential({
      certificate: decryptSecret(c.fielCer),
      privateKey: decryptSecret(c.fielKey),
      password: decryptSecret(c.fielPassword),
    });
    credencial = "creada";
  }

  // Dispara extracciones frescas sin esperar; el resultado se lee con el sync.
  await Promise.allSettled([
    client.createExtraction({ extractor: "tax_compliance", entity: entityId }),
    client.createExtraction({ extractor: "tax_status", entity: entityId }),
  ]);

  return { companyId: c.id, rfc: c.rfc, entityId, credencial };
}

/** Aprovisiona una sola empresa (ruta ?companyId=). */
export async function provisionCompany(
  companyId: string,
  client = new SyntageClient(),
): Promise<ProvisionResult> {
  const c = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, rfc: true, razonSocial: true, fielCer: true, fielKey: true, fielPassword: true },
  });
  if (!c) return { companyId, error: "Empresa no encontrada" };
  if (!c.fielCer || !c.fielKey || !c.fielPassword) {
    return { companyId, rfc: c.rfc, skipped: true, error: "Sin e.firma guardada" };
  }
  const [entities, creds] = await Promise.all([client.listEntities(), client.listCredentials()]);
  return provisionOne(client, c as FielCompany, entities, creds);
}

/** Aprovisiona TODAS las empresas que tienen e.firma guardada. */
export async function provisionAllCompanies(): Promise<{
  empresas: number;
  errores: number;
  resultados: ProvisionResult[];
}> {
  const client = new SyntageClient();
  const companies = await prisma.company.findMany({
    where: { fielCer: { not: null }, fielKey: { not: null }, fielPassword: { not: null } },
    select: { id: true, rfc: true, razonSocial: true, fielCer: true, fielKey: true, fielPassword: true },
  });
  const [entities, creds] = await Promise.all([client.listEntities(), client.listCredentials()]);

  const resultados: ProvisionResult[] = [];
  let errores = 0;
  for (const c of companies) {
    try {
      resultados.push(await provisionOne(client, c as FielCompany, entities, creds));
    } catch (e) {
      errores++;
      resultados.push({ companyId: c.id, rfc: c.rfc, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { empresas: companies.length, errores, resultados };
}
