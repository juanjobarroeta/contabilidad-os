/**
 * Push notifications del satélite de construcción (bartiz), dirigidas por
 * construccionRol en vez de "toda la empresa" (sendPushToCompany notificaría
 * también al despacho y a roles ajenos al evento — puro ruido).
 *
 * Destinos:
 *   ADMIN        — miembros OWNER/ADMIN sin rol restringido (o rol ADMIN):
 *                  Gerardo y Juan. Autorizan compras y ven todo.
 *   TESORERIA / RESIDENTE / CONTABILIDAD — construccionRol exacto.
 *   userIds      — destinatarios puntuales (p. ej. quien creó la requisición).
 *
 * excludeUserId saca al actor: quien aprueba no necesita un push de que él
 * mismo aprobó.
 *
 * NUNCA lanza y se usa fire-and-forget (`void notificarConstruccion(...)`)
 * después de la transacción: un push caído jamás debe tirar la operación, y
 * el servidor (Railway, proceso persistente) termina el envío en background.
 * Sin llaves VAPID configuradas, sendPushToUser es no-op.
 */

import { prisma } from "../prisma";
import { sendPushToUser, type PushPayload } from "../push";

export type DestinoPush = "ADMIN" | "TESORERIA" | "RESIDENTE" | "CONTABILIDAD";

export async function notificarConstruccion(opts: {
  companyId: string;
  destinos: DestinoPush[];
  payload: PushPayload;
  /** Destinatarios puntuales adicionales (ids de User; null/undefined se ignoran). */
  userIds?: (string | null | undefined)[];
  /** El actor del evento — se excluye para no notificarse a sí mismo. */
  excludeUserId?: string | null;
}): Promise<void> {
  try {
    const ids = new Set<string>();
    for (const u of opts.userIds ?? []) if (u) ids.add(u);

    if (opts.destinos.length > 0) {
      const roles = opts.destinos.filter((d) => d !== "ADMIN");
      const quiereAdmins = opts.destinos.includes("ADMIN");
      const members = await prisma.companyMember.findMany({
        where: {
          companyId: opts.companyId,
          OR: [
            ...(roles.length > 0
              ? [{ construccionRol: { in: roles as ("TESORERIA" | "RESIDENTE" | "CONTABILIDAD")[] } }]
              : []),
            ...(quiereAdmins
              ? [
                  {
                    role: { in: ["OWNER", "ADMIN"] as ("OWNER" | "ADMIN")[] },
                    OR: [{ construccionRol: null }, { construccionRol: "ADMIN" as const }],
                  },
                ]
              : []),
          ],
        },
        select: { userId: true },
      });
      members.forEach((m) => ids.add(m.userId));
    }

    if (opts.excludeUserId) ids.delete(opts.excludeUserId);
    if (ids.size === 0) return;

    await Promise.all(
      [...ids].map((userId) =>
        sendPushToUser(userId, opts.payload, "construccion").catch(() => {})
      )
    );
  } catch (err) {
    console.warn("[construccion/push] notificación fallida (ignorada):", err);
  }
}

const fmt = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 0,
});

/** "$12,345" — los push son cortos; centavos no aportan. */
export function moneyPush(n: number): string {
  return fmt.format(n || 0);
}
