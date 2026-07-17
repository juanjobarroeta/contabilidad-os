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
import { empresasConPagoVigente } from "@/lib/billing/pagadores";
import { SyntageClient } from "./client";
import {
  EXTRACTORES_PROVISION,
  debeArrancarCE,
  extractoresADisparar,
  type ExtractorProvision,
} from "./cadencia";

type Json = Record<string, unknown>;

export interface ProvisionResult {
  companyId: string;
  rfc?: string;
  entityId?: string;
  credencial?: "valida" | "creada";
  skipped?: boolean;
  /** Por qué se omitió (p.ej. "sin_pago_vigente") — no es un error. */
  motivo?: string;
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
  /** Si null, aún no se ha arrancado la Contabilidad Electrónica (apertura única). */
  ceBootstrapAt: Date | null;
}

const FIEL_SELECT = {
  id: true,
  rfc: true,
  razonSocial: true,
  tier: true,
  fielCer: true,
  fielKey: true,
  fielPassword: true,
  ceBootstrapAt: true,
} as const;

/** Última extracción exitosa de cada fuente Syntage (del ledger de costos). */
async function ultimasExtracciones(companyId: string): Promise<{
  porExtractor: Partial<Record<ExtractorProvision, Date | null>>;
  /** Último disparo del bootstrap de CE (para su piso de reintento). */
  ultimoIntentoCE: Date | null;
}> {
  const rows = await prisma.costEvent.groupBy({
    by: ["subtipo"],
    where: { companyId, categoria: "SYNTAGE" },
    _max: { occurredAt: true },
  });
  const porExtractor: Partial<Record<ExtractorProvision, Date | null>> = {};
  let ultimoIntentoCE: Date | null = null;
  for (const r of rows) {
    const ex = r.subtipo.replace("syntage.extraction.", "");
    if ((EXTRACTORES_PROVISION as readonly string[]).includes(ex)) {
      porExtractor[ex as ExtractorProvision] = r._max.occurredAt ?? null;
    } else if (ex === "electronic_accounting") {
      ultimoIntentoCE = r._max.occurredAt ?? null;
    }
  }
  return { porExtractor, ultimoIntentoCE };
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
  const [ultimas, presentes] = await Promise.all([
    ultimasExtracciones(c.id),
    datosPresentes(c.id),
  ]);
  const pendientes = extractoresADisparar({
    plan: c.tier,
    ultimaPorExtractor: ultimas.porExtractor,
    datosPresentes: presentes,
    ahora: new Date(),
    force: opts?.force,
  });

  // Arranque ÚNICO de la Contabilidad Electrónica (apertura): si esta empresa
  // aún no se ha bootstrapeado (`ceBootstrapAt == null`), disparamos TAMBIÉN el
  // extractor `electronic_accounting` junto con la cadencia. El sync cosecha el
  // resultado, importa catálogo + balanza y sólo entonces fija `ceBootstrapAt`.
  // Si el SAT no devuelve CE (empresas que nunca la presentan), el piso de 30
  // días de debeArrancarCE evita re-disparar cada corrida (antes: 1/día/RFC).
  const arrancarCE = debeArrancarCE({
    plan: c.tier,
    ceBootstrapAt: c.ceBootstrapAt,
    ultimoIntentoCE: ultimas.ultimoIntentoCE,
    ahora: new Date(),
    force: opts?.force,
  });

  // Si no hay extracciones de cadencia pendientes NI arranque de CE, no creamos
  // entidad/credencial en vano (igual son idempotentes).
  if (pendientes.length === 0 && !arrancarCE) {
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

  // Arranque de CE (best-effort, una sola vez). El registro se lee/importa en el
  // sync; el costo se mide como CostEvent igual que las demás extracciones.
  if (arrancarCE) {
    try {
      await client.createExtraction({ extractor: "electronic_accounting", entity: entityId });
      void recordSyntageExtraction("electronic_accounting", { companyId: c.id });
    } catch {
      // No rompemos el aprovisionamiento si el disparo de CE falla; el sync
      // reintentará en una corrida posterior (ceBootstrapAt sigue null).
    }
  }

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

  // Clientes que dejaron de pagar NO generan más COGS: si ningún pagador de la
  // empresa (OWNER/ADMIN propio o de su despacho) tiene suscripción vigente,
  // se pausan sus extracciones. El slot en Syntage lo libera el cron
  // syntage-liberar-slots; si vuelven a pagar, esto se reactiva solo.
  const conPago = await empresasConPagoVigente(companies.map((c) => c.id));

  const resultados: ProvisionResult[] = [];
  let errores = 0;
  for (const c of companies) {
    if (!conPago.has(c.id)) {
      resultados.push({ companyId: c.id, rfc: c.rfc, skipped: true, motivo: "sin_pago_vigente" });
      continue;
    }
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
