import { prisma } from "@/lib/prisma";
import { parseCfdiXml } from "@/lib/sat-fiel";
import { REGIMENES_ASIMILADOS } from "@/lib/nomina/regimen";

// ─────────────────────────────────────────────────────────────────────────────
// Rellena regimenNomina / tipoNomina / isrRetenidoNomina de los CFDIs tipo
// NOMINA ya importados, re-parseando el rawXml guardado. Necesario para los
// recibos (p. ej. asimilados a salarios) sincronizados ANTES de que el import
// parseara el complemento de nómina. Es idempotente y seguro de re-ejecutar:
// sólo toca filas con regimenNomina = null y rawXml presente.
//
// Se usa desde el cron (/api/cron/nomina-backfill) y, sobre todo, al final de
// cada sincronización del SAT — así el usuario sólo presiona "Sincronizar CFDIs"
// y los recibos existentes quedan reconocidos, sin pasos manuales.
// ─────────────────────────────────────────────────────────────────────────────

export interface BackfillNominaResult {
  scanned: number;
  updated: number;
  asimilados: number;
  porRegimen: Record<string, number>;
  remaining: number;
}

export async function backfillNominaRegimen(
  companyId?: string,
  opts?: { timeBudgetMs?: number; pageSize?: number }
): Promise<BackfillNominaResult> {
  const PAGE = opts?.pageSize ?? 300;
  const TIME_BUDGET_MS = opts?.timeBudgetMs ?? 240_000;
  const startedAt = Date.now();

  const where = {
    tipo: "NOMINA" as const,
    regimenNomina: null,
    rawXml: { not: null },
    ...(companyId ? { companyId } : {}),
  };

  let lastId: string | undefined;
  let scanned = 0;
  let updated = 0;
  let asimilados = 0;
  const porRegimen: Record<string, number> = {};

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const page = await prisma.invoice.findMany({
      where: { ...where, ...(lastId ? { id: { gt: lastId } } : {}) },
      select: { id: true, rawXml: true },
      orderBy: { id: "asc" },
      take: PAGE,
    });
    if (page.length === 0) break;

    for (const inv of page) {
      scanned++;
      if (!inv.rawXml) continue;
      let parsed;
      try {
        parsed = parseCfdiXml(inv.rawXml);
      } catch {
        continue; // XML ilegible → revisión manual
      }
      const n = parsed.nomina;
      if (!n?.tipoRegimen) continue;
      await prisma.invoice.update({
        where: { id: inv.id },
        data: {
          regimenNomina: n.tipoRegimen,
          tipoNomina: n.tipoNomina ?? null,
          isrRetenidoNomina: n.isrRetenido ?? null,
        },
      });
      updated++;
      porRegimen[n.tipoRegimen] = (porRegimen[n.tipoRegimen] ?? 0) + 1;
      if (REGIMENES_ASIMILADOS.includes(n.tipoRegimen)) asimilados++;
    }

    lastId = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }

  const remaining = await prisma.invoice.count({ where });
  return { scanned, updated, asimilados, porRegimen, remaining };
}
