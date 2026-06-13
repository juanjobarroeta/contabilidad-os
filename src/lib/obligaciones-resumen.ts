import { prisma } from "./prisma";
import { calcularVencimiento, type ObligacionConfig } from "./obligaciones";

// Cuenta, EN LOTE, las obligaciones vencidas / por vencer de varias empresas —
// mismo criterio que el calendario de /api/obligaciones, pero agregado para el
// cockpit (¿qué empresas están atrasadas?). Dos queries, no 2 por empresa.

const MAP_DECL: Record<string, string | null> = {
  IVA_MENSUAL: "IVA_MENSUAL",
  ISR_PROVISIONAL: "ISR_PROVISIONAL",
  RETENCIONES_ISR: "RETENCIONES_ISR",
  DIOT: "IVA_MENSUAL",
  ISR_ANUAL: "DECLARACION_ANUAL",
  ISR_BIMESTRAL: "IVA_MENSUAL",
  IVA_BIMESTRAL: "IVA_MENSUAL",
};

function buildPeriodos(periodicidad: string, year: number): string[] {
  if (periodicidad === "ANUAL") return [String(year)];
  if (periodicidad === "BIMESTRAL") return ["B1", "B2", "B3", "B4", "B5", "B6"].map((b) => `${year}-${b}`);
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

export interface ResumenObligaciones {
  vencidas: number;
  porVencer: number;
}

const VENTANA_MS = 30 * 24 * 60 * 60 * 1000;

export async function resumenObligacionesPorEmpresa(
  companyIds: string[],
  year: number,
  asOf: Date = new Date()
): Promise<Map<string, ResumenObligaciones>> {
  const out = new Map<string, ResumenObligaciones>();
  for (const id of companyIds) out.set(id, { vencidas: 0, porVencer: 0 });
  if (companyIds.length === 0) return out;

  const [obligaciones, declaraciones, companies] = await Promise.all([
    prisma.companyObligation.findMany({ where: { companyId: { in: companyIds }, activa: true } }),
    prisma.taxDeclaration.findMany({
      where: { companyId: { in: companyIds }, periodo: { startsWith: String(year) } },
      select: { companyId: true, tipo: true, periodo: true, status: true, isrPagar: true },
    }),
    prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, createdAt: true } }),
  ]);

  const createdAt = new Map(companies.map((c) => [c.id, c.createdAt]));
  const declByCo = new Map<string, Map<string, string>>();
  for (const id of companyIds) declByCo.set(id, new Map());
  for (const d of declaraciones) {
    declByCo.get(d.companyId)?.set(`${d.tipo}::${d.periodo}`, d.status);
  }
  // Compat legado: renglón IVA que cargaba el ISR provisional.
  for (const d of declaraciones) {
    if (d.tipo === "IVA_MENSUAL" && d.isrPagar != null) {
      const m = declByCo.get(d.companyId);
      const k = `ISR_PROVISIONAL::${d.periodo}`;
      if (m && !m.has(k)) m.set(k, d.status);
    }
  }

  for (const ob of obligaciones) {
    const cfg: ObligacionConfig = {
      tipo: ob.tipo,
      descripcion: ob.descripcion,
      periodicidad: ob.periodicidad as "MENSUAL" | "BIMESTRAL" | "ANUAL",
      diaVencimiento: ob.diaVencimiento,
      mesVencimiento: ob.mesVencimiento ?? undefined,
    };
    const declTipo = MAP_DECL[ob.tipo] ?? null;
    const created = createdAt.get(ob.companyId) ?? new Date(0);
    const declMap = declByCo.get(ob.companyId);
    const r = out.get(ob.companyId);
    if (!declMap || !r) continue;

    for (const periodo of buildPeriodos(ob.periodicidad, year)) {
      const venc = calcularVencimiento(cfg, periodo);
      const st = declTipo ? declMap.get(`${declTipo}::${periodo}`) : undefined;
      if (st === "FILED" || st === "PAID" || st === "CALCULATED") continue; // presentada / en proceso
      if (venc < created) continue; // periodo previo al alta de la empresa
      if (venc < asOf) r.vencidas++;
      else if (venc.getTime() - asOf.getTime() < VENTANA_MS) r.porVencer++;
    }
  }
  return out;
}
