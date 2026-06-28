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

import type { CompanyPlan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { recordSyntageExtraction } from "@/lib/costos/record";
import { planIncluyeSyntage } from "@/lib/planes";
import { SyntageClient } from "./client";
import { EXTRACTORES_PROVISION, extractoresADisparar, type ExtractorProvision } from "./cadencia";

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
  tier: CompanyPlan;
  fielCer: string;
  fielKey: string;
  fielPassword: string;
}

const FIEL_SELECT = {
  id: true,
  rfc: true,
  razonSocial: true,
  tier: true,
  fielCer: true,
  fielKey: true,
  fielPassword: true,
} as const;

/** Última extracción exitosa de cada fuente Syntage (del ledger de costos). */
async function ultimasExtracciones(
  companyId: string,
): Promise<Partial<Record<ExtractorProvision, Date | null>>> {
  const rows = await prisma.costEvent.groupBy({
    by: ["subtipo"],
    where: { companyId, categoria: "SYNTAGE" },
    _max: { occurredAt: true },
  });
  const out: Partial<Record<ExtractorProvision, Date | null>> = {};
  for (const r of rows) {
    const ex = r.subtipo.replace("syntage.extraction.", "") as ExtractorProvision;
    if ((EXTRACTORES_PROVISION as readonly string[]).includes(ex)) out[ex] = r._max.occurredAt ?? null;
  }
  return out;
}

/**
 * ¿Aterrizó el dato derivado de cada extractor? La cadencia se basa en CostEvent
 * (¿disparamos/cobramos?), que NO garantiza que el dato exista (extracción async,
 * fallo, o entidad mal resuelta en el sync). Esto deja que `extractoresADisparar`
 * re-dispare lo que falta. Mapeo extractor → evidencia persistida:
 *   tax_compliance    → ComplianceSnapshot SAT_OPINION
 *   tax_status        → ComplianceSnapshot CSF
 *   annual_tax_return → TaxDeclaration DECLARACION_ANUAL
 *   monthly_tax_return→ TaxDeclaration IVA_MENSUAL | ISR_PROVISIONAL
 */
async function datosPresentes(
  companyId: string,
): Promise<Partial<Record<ExtractorProvision, boolean>>> {
  const [opinion, csf, anual, mensual] = await Promise.all([
    prisma.complianceSnapshot.findFirst({ where: { companyId, tipo: "SAT_OPINION" }, select: { id: true } }),
    prisma.complianceSnapshot.findFirst({ where: { companyId, tipo: "CSF" }, select: { id: true } }),
    prisma.taxDeclaration.findFirst({ where: { companyId, tipo: "DECLARACION_ANUAL" }, select: { id: true } }),
    prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: { in: ["IVA_MENSUAL", "ISR_PROVISIONAL"] } },
      select: { id: true },
    }),
  ]);
  return {
    tax_compliance: !!opinion,
    tax_status: !!csf,
    annual_tax_return: !!anual,
    monthly_tax_return: !!mensual,
  };
}

async function provisionOne(
  client: SyntageClient,
  c: FielCompany,
  entities: Json[],
  creds: Json[],
  opts?: { force?: boolean },
): Promise<ProvisionResult> {
  // Empresas sin Syntage en su plan (ASISTENTE) no gastan extracciones —
  // ni siquiera creamos entidad/credencial — salvo aprovisionamiento manual (force).
  if (!planIncluyeSyntage(c.tier) && !opts?.force) {
    return { companyId: c.id, rfc: c.rfc, skipped: true };
  }

  // Decide QUÉ extraer antes de tocar a Syntage: por plan + cadencia. Si no hay
  // nada pendiente, no creamos entidad/credencial en vano (igual son idempotentes).
  const [ultimaPorExtractor, presentes] = await Promise.all([
    ultimasExtracciones(c.id),
    datosPresentes(c.id),
  ]);
  const pendientes = extractoresADisparar({
    plan: c.tier,
    ultimaPorExtractor,
    datosPresentes: presentes,
    ahora: new Date(),
    force: opts?.force,
  });
  if (pendientes.length === 0) {
    return { companyId: c.id, rfc: c.rfc, skipped: true };
  }

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

  // Dispara sólo las extracciones pendientes (cadencia). El resultado se lee con
  // el sync; cada disparo se mide en CostEvent (que a su vez alimenta la cadencia).
  const results = await Promise.allSettled(
    pendientes.map((extractor) => client.createExtraction({ extractor, entity: entityId })),
  );
  results.forEach((r, i) => {
    if (r.status === "fulfilled") void recordSyntageExtraction(pendientes[i], { companyId: c.id });
  });

  return { companyId: c.id, rfc: c.rfc, entityId, credencial };
}

/**
 * Aprovisiona una sola empresa (ruta ?companyId=). Manual = `force` por defecto:
 * dispara la extracción completa de inmediato (onboarding / re-provisión), sin
 * importar plan ni cadencia.
 */
export async function provisionCompany(
  companyId: string,
  client = new SyntageClient(),
  opts?: { force?: boolean },
): Promise<ProvisionResult> {
  const c = await prisma.company.findUnique({
    where: { id: companyId },
    select: FIEL_SELECT,
  });
  if (!c) return { companyId, error: "Empresa no encontrada" };
  if (!c.fielCer || !c.fielKey || !c.fielPassword) {
    return { companyId, rfc: c.rfc, skipped: true, error: "Sin e.firma guardada" };
  }
  const [entities, creds] = await Promise.all([client.listEntities(), client.listCredentials()]);
  return provisionOne(client, c as FielCompany, entities, creds, { force: opts?.force ?? true });
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
    select: FIEL_SELECT,
  });
  const [entities, creds] = await Promise.all([client.listEntities(), client.listCredentials()]);

  const resultados: ProvisionResult[] = [];
  let errores = 0;
  for (const c of companies) {
    try {
      // Cron = sin force: respeta plan + cadencia (el ahorro de COGS).
      resultados.push(await provisionOne(client, c as FielCompany, entities, creds));
    } catch (e) {
      errores++;
      resultados.push({ companyId: c.id, rfc: c.rfc, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { empresas: companies.length, errores, resultados };
}
