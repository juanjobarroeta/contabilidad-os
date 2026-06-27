import { sendPushToUser } from "./push";
import { empresasAccesiblesIds } from "./authz";
import { prisma } from "./prisma";

/**
 * Digest diario del auditor ("contador 24/7"): un solo push por usuario que
 * resume los hallazgos ABIERTOS en TODAS sus empresas accesibles (Revisión).
 * Convierte la detección que ya corre a diario en algo que busca al usuario, en
 * vez de esperar a que entre. No-op si no hay nada abierto o si push no está
 * configurado. Respeta la preferencia "revision" (opt-out).
 */
export async function notifyHallazgosDigest(
  userId: string
): Promise<{ notified: number; total: number; criticos: number; empresas: number }> {
  const ids = await empresasAccesiblesIds(userId);
  if (ids.length === 0) return { notified: 0, total: 0, criticos: 0, empresas: 0 };

  // Excluye los pospuestos (snooze): no deben empujar el digest hasta que venzan.
  const grupos = await prisma.fiscalHallazgo.groupBy({
    by: ["companyId", "severidad"],
    where: {
      companyId: { in: ids },
      estado: "ABIERTO",
      OR: [{ posponerHasta: null }, { posponerHasta: { lte: new Date() } }],
    },
    _count: true,
  });

  let total = 0;
  let criticos = 0;
  const empresas = new Set<string>();
  for (const g of grupos) {
    total += g._count;
    if (g.severidad === "error") criticos += g._count;
    empresas.add(g.companyId);
  }
  if (total === 0) return { notified: 0, total: 0, criticos: 0, empresas: 0 };

  const nEmp = empresas.size;
  const cuerpo =
    (criticos > 0 ? `${criticos} crítico${criticos === 1 ? "" : "s"}. ` : "") +
    `En ${nEmp} empresa${nEmp === 1 ? "" : "s"}. Toca para revisar y resolver.`;

  const r = await sendPushToUser(
    userId,
    {
      title: `${total} cosa${total === 1 ? "" : "s"} por revisar hoy`,
      body: cuerpo,
      // Despacho (varias empresas) → al briefing "Hoy" de la cartera; usuario de
      // una sola empresa → directo a sus hallazgos.
      url: ids.length > 1 ? "/despacho" : "/hallazgos",
      tag: "revision-digest", // colapsa el aviso diario en uno
    },
    "revision"
  );
  return { notified: r.sent, total, criticos, empresas: nEmp };
}
