import { prisma } from "./prisma";
import { sendPushToCompany } from "./push";

const fmt = (n: number) =>
  "$" + Number(n).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Push a digest of CFDIs newly imported for `companyId` since `since` —
 * "facturas emitidas / recibidas". One per-sync summary (not one per invoice),
 * so a busy sync doesn't spam. No-ops if nothing new (or push isn't configured).
 * Only counts INGRESO (emitidas) / EGRESO (recibidas); nómina/REP are excluded.
 */
export async function notifyNewInvoices(companyId: string, since: Date): Promise<{ notified: number }> {
  const grouped = await prisma.invoice.groupBy({
    by: ["tipo"],
    where: { companyId, createdAt: { gte: since }, tipo: { in: ["INGRESO", "EGRESO"] } },
    _count: { _all: true },
    _sum: { total: true },
  });

  let emitidas = 0, recibidas = 0, montoEmit = 0, montoReci = 0;
  for (const g of grouped) {
    if (g.tipo === "INGRESO") { emitidas = g._count._all; montoEmit = g._sum.total ?? 0; }
    else if (g.tipo === "EGRESO") { recibidas = g._count._all; montoReci = g._sum.total ?? 0; }
  }
  if (emitidas === 0 && recibidas === 0) return { notified: 0 };

  const parts: string[] = [];
  if (emitidas) parts.push(`${emitidas} emitida${emitidas === 1 ? "" : "s"} (${fmt(montoEmit)})`);
  if (recibidas) parts.push(`${recibidas} recibida${recibidas === 1 ? "" : "s"} (${fmt(montoReci)})`);
  const total = emitidas + recibidas;

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { razonSocial: true },
  });

  const r = await sendPushToCompany(companyId, {
    title: `${total} factura${total === 1 ? "" : "s"} nueva${total === 1 ? "" : "s"}`,
    body: `${company?.razonSocial ? company.razonSocial + " — " : ""}${parts.join(" · ")}`,
    url: "/facturas",
    tag: `sync-${companyId}`,
  }, "cfdis");
  return { notified: r.sent };
}
