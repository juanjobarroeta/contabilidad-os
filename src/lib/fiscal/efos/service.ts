// ─────────────────────────────────────────────────────────────────────────────
// Servicio de cotejo 69-B: para cada empresa, coteja su RFC propio + todas sus
// contrapartes (clientes y proveedores extraídos de los CFDIs → tabla Customer)
// contra la lista del SAT, y persiste los hallazgos en FiscalHallazgo. Idempotente:
// un hallazgo vigente se actualiza en su lugar; los que dejan de aplicar se
// auto-resuelven. El cron lo corre a diario.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { revisarRfcs } from "./check";
import type { ListaEfos, RfcEntrada } from "./types";
import type { Hallazgo } from "../audit/types";

async function persistEfosHallazgos(companyId: string, hallazgos: Hallazgo[]): Promise<number> {
  const vigentes = new Set<string>();
  for (const h of hallazgos) {
    const dedupeKey = `${h.checkClave}|${h.referencias.join(",")}`;
    vigentes.add(dedupeKey);
    await prisma.fiscalHallazgo.upsert({
      where: { companyId_dedupeKey: { companyId, dedupeKey } },
      create: {
        companyId,
        dedupeKey,
        checkClave: h.checkClave,
        severidad: h.severidad,
        mensaje: h.mensaje,
        referencias: h.referencias,
        sugerencia: h.sugerencia,
        fundamentoLey: h.fundamento.ley,
        fundamentoArticulo: h.fundamento.articulo,
        fundamentoFraccion: h.fundamento.fraccion ?? null,
      },
      update: {
        severidad: h.severidad,
        mensaje: h.mensaje,
        referencias: h.referencias,
        sugerencia: h.sugerencia,
      },
      select: { id: true },
    });
  }

  // Auto-resolver hallazgos EFOS previos que ya no aparecen (p.ej. desvirtuados).
  const abiertos = await prisma.fiscalHallazgo.findMany({
    where: { companyId, estado: "ABIERTO", checkClave: { startsWith: "efos." } },
    select: { id: true, dedupeKey: true },
  });
  const obsoletos = abiertos.filter((a) => !vigentes.has(a.dedupeKey)).map((a) => a.id);
  if (obsoletos.length > 0) {
    await prisma.fiscalHallazgo.updateMany({
      where: { id: { in: obsoletos } },
      data: { estado: "RESUELTO" },
    });
  }
  return hallazgos.length;
}

/** Coteja una empresa (propio + contrapartes) contra la lista y persiste. */
export async function screenCompanyEfos(companyId: string, lista: ListaEfos) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true },
  });
  if (!company) return { companyId, evaluados: 0, flagged: 0 };

  const customers = await prisma.customer.findMany({
    where: { companyId },
    select: { rfc: true, razonSocial: true },
  });

  const entradas: RfcEntrada[] = [
    { rfc: company.rfc, rol: "PROPIO" },
    ...customers.map((c): RfcEntrada => ({ rfc: c.rfc, rol: "CONTRAPARTE", nombre: c.razonSocial })),
  ];

  const hallazgos = revisarRfcs(entradas, lista);
  const flagged = await persistEfosHallazgos(companyId, hallazgos);
  return { companyId, evaluados: entradas.length, flagged };
}

/** Descarga la lista una vez y coteja todas las empresas. */
export async function screenAllCompaniesEfos(lista: ListaEfos) {
  const companies = await prisma.company.findMany({ select: { id: true } });
  const resultados = [];
  let errores = 0;
  for (const c of companies) {
    try {
      resultados.push(await screenCompanyEfos(c.id, lista));
    } catch (e) {
      errores++;
      resultados.push({ companyId: c.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { empresas: companies.length, rfcsEnLista: lista.size, errores, resultados };
}
