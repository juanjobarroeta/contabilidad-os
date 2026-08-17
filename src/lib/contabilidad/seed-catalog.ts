import { prisma } from "../prisma";
import { resolverCuentaPropia } from "./resolver-plan-propio";
import { SAT_STARTER_CATALOG } from "./catalog";
import { EXTRA_ACCOUNTS_FOR_CLASSIFICATION } from "./classify-egreso";
import { naturalezaPorTipo } from "./coe-saldos";

/**
 * Seeds the SAT COE starter catalog for a company. Idempotent — skips
 * accounts that already exist keyed on (companyId, cuentaSAT, subcuenta).
 *
 * Called by:
 *   - POST /api/companies after company creation (best-effort)
 *   - scripts/repair-codigo-agrupador.ts (repara catálogos con códigos viejos)
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
        naturaleza: acc.naturaleza ?? naturalezaPorTipo(acc.tipo),
      },
    });
    created++;
  }

  return { created, skipped };
}

/**
 * Resolve a ChartAccount row by its SAT code. Used throughout the posting
 * engine. Si la cuenta no existe pero SÍ está definida en el catálogo semilla
 * (starter o extras del clasificador), se AUTOCREA — así un cambio de códigos
 * en el catálogo no rompe el posteo de empresas sembradas con la versión
 * anterior (el cron postea antes de que corra el script de reparación).
 * Sólo lanza para códigos desconocidos.
 */
export async function resolveAccount(companyId: string, code: string) {
  // FASE 1 (plan propio): si la empresa tiene su CT importado con codAgrup y
  // este código resuelve SIN ambigüedad (o hay override del contador), el
  // asiento cae en la cuenta PROPIA — la misma que declara la balanza. Si no,
  // el fallback de abajo postea exactamente como siempre. Ver
  // docs/PLAN-motor-plan-propio.md y resolver-plan-propio.ts.
  const propia = await resolverCuentaPropia(companyId, code);
  if (propia) return propia;

  // `code` may be a parent code ("102") or subaccount ("102.01").
  // We always match on subcuenta (the most specific) first.
  // SÓLO cuentas ACTIVAS: durante la reparación de códigos conviven dos filas
  // con el mismo código (la vieja mal nombrada y la oficial) — resolver la
  // inactiva re-postearía sobre la cuenta equivocada.
  const acc = await prisma.chartAccount.findFirst({
    where: {
      companyId,
      isActive: true,
      OR: [{ subcuenta: code }, { cuentaSAT: code, subcuenta: null }],
    },
    orderBy: { createdAt: "desc" },
  });
  if (acc) return acc;

  const def = [...SAT_STARTER_CATALOG, ...EXTRA_ACCOUNTS_FOR_CLASSIFICATION].find(
    (a) => (a.subcuenta ?? a.cuentaSAT) === code
  );
  if (!def) {
    throw new Error(`ChartAccount no encontrada: ${code}. Siembra el catálogo primero.`);
  }
  return prisma.chartAccount.create({
    data: {
      companyId,
      cuentaSAT: def.cuentaSAT,
      subcuenta: def.subcuenta,
      nombre: def.nombre,
      tipo: def.tipo,
      nivel: def.nivel,
      naturaleza: def.naturaleza ?? naturalezaPorTipo(def.tipo),
    },
  });
}
