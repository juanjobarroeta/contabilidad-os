import { prisma } from "../prisma";
import { SAT_STARTER_CATALOG } from "./catalog";
import { EXTRA_ACCOUNTS_FOR_CLASSIFICATION } from "./classify-egreso";

/**
 * Seeds the SAT COE starter catalog for a company. Idempotent — uses
 * `upsert` keyed on (companyId, cuentaSAT, subcuenta).
 *
 * Called by:
 *   - POST /api/companies after company creation (best-effort)
 *   - POST /api/contabilidad/seed (manual trigger / retry)
 *   - prisma/scripts/backfill-catalog.ts (one-time backfill)
 */
export async function seedChartOfAccounts(companyId: string) {
  let created = 0;
  let skipped = 0;

  const allAccounts = [...SAT_STARTER_CATALOG, ...EXTRA_ACCOUNTS_FOR_CLASSIFICATION];

  for (const acc of allAccounts) {
    const existing = await prisma.chartAccount.findFirst({
      where: {
        companyId,
        cuentaSAT: acc.cuentaSAT,
        subcuenta: acc.subcuenta ?? null,
      },
    });

    if (existing) {
      skipped++;
      continue;
    }

    await prisma.chartAccount.create({
      data: {
        companyId,
        cuentaSAT: acc.cuentaSAT,
        subcuenta: acc.subcuenta,
        nombre: acc.nombre,
        tipo: acc.tipo,
        nivel: acc.nivel,
      },
    });
    created++;
  }

  return { created, skipped };
}

/**
 * Resolve a ChartAccount row by its SAT code. Used throughout the posting
 * engine. Throws if the account doesn't exist — callers should make sure
 * the catalog is seeded before posting.
 */
export async function resolveAccount(companyId: string, code: string) {
  // `code` may be a parent code ("102") or subaccount ("102.01").
  // We always match on subcuenta (the most specific) first.
  const acc = await prisma.chartAccount.findFirst({
    where: {
      companyId,
      OR: [{ subcuenta: code }, { cuentaSAT: code, subcuenta: null }],
    },
  });
  if (!acc) {
    throw new Error(`ChartAccount no encontrada: ${code}. Siembra el catálogo primero.`);
  }
  return acc;
}
