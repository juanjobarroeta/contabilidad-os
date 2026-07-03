import { prisma } from "./prisma";
import { usuariosConAccesoACompany } from "./push";
import { registrarYNotificar, fechaLocalMx, inicioDelDiaMx } from "./notificaciones";

const fmt = (n: number) =>
  "$" + Number(n).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Aviso de CFDIs recién importados para `companyId` — "facturas emitidas /
 * recibidas". Pasa por la capa de dedup del inbox (`registrarYNotificar`) con
 * dedupeKey `cfdi-nuevos:<companyId>:<YYYY-MM-DD>` (día local de México) y
 * `pushSoloAlCrear`, lo que da A LO MÁS UN PUSH AL DÍA por empresa y usuario:
 *
 *   - El primer sync del día que importa algo CREA el item → push.
 *   - Los syncs siguientes del mismo día sólo ACTUALIZAN el conteo acumulado
 *     del día en el inbox, en silencio (sin re-push). Antes se re-empujaba en
 *     cada corrida del cron (hasta 3 pushes/día por importaciones rutinarias).
 *
 * El cuerpo acumula: se recalculan los totales de TODO el día (no sólo de esta
 * corrida), así el item del inbox siempre muestra el conteo del día completo.
 * `since` (inicio de la corrida) sigue siendo el guard de no-op: si ESTA corrida
 * no importó nada, no se toca nada. Sólo cuenta INGRESO (emitidas) / EGRESO
 * (recibidas); nómina/REP se excluyen. Best-effort: no truena el cron.
 */
export async function notifyNewInvoices(
  companyId: string,
  since: Date,
  now: Date = new Date(),
): Promise<{ notified: number }> {
  // Guard: ¿esta corrida importó algo? Si no, silencio total (ni escritura).
  const importadasEstaCorrida = await prisma.invoice.count({
    where: { companyId, createdAt: { gte: since }, tipo: { in: ["INGRESO", "EGRESO"] } },
  });
  if (importadasEstaCorrida === 0) return { notified: 0 };

  // Totales acumulados de TODO el día (México), para que el item del inbox
  // refleje el día completo aunque haya varios syncs.
  const grouped = await prisma.invoice.groupBy({
    by: ["tipo"],
    where: { companyId, createdAt: { gte: inicioDelDiaMx(now) }, tipo: { in: ["INGRESO", "EGRESO"] } },
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

  const titulo = `${total} factura${total === 1 ? "" : "s"} nueva${total === 1 ? "" : "s"} hoy`;
  const cuerpo = `${company?.razonSocial ? company.razonSocial + " — " : ""}${parts.join(" · ")}`;
  const dedupeKey = `cfdi-nuevos:${companyId}:${fechaLocalMx(now)}`;

  const userIds = await usuariosConAccesoACompany(companyId);
  let notified = 0;
  for (const userId of userIds) {
    try {
      const r = await registrarYNotificar({
        recipientUserId: userId,
        companyId,
        categoria: "otro",
        severidad: "info",
        titulo,
        cuerpo,
        url: "/facturas",
        dedupeKey,
        categoriaPush: "cfdis",
        pushSoloAlCrear: true, // tope diario: sólo el primer sync del día empuja
      });
      if (r.pushSent) notified++;
    } catch (e) {
      console.error(`[notify-new-invoices] aviso a ${userId} falló:`, e);
    }
  }
  return { notified };
}
