import webpush from "web-push";
import { prisma } from "./prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Web Push sender. VAPID keys come from env (generate once with
// `npx web-push generate-vapid-keys`):
//   VAPID_PUBLIC_KEY   — also exposed to the client as NEXT_PUBLIC_VAPID_PUBLIC_KEY
//   VAPID_PRIVATE_KEY
//   VAPID_SUBJECT      — e.g. "mailto:soporte@contabilidad-os.com"
// If keys are missing we no-op (so the app runs fine before push is configured).
// ─────────────────────────────────────────────────────────────────────────────

let configured: boolean | null = null;
function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:soporte@contabilidad-os.com",
    pub,
    priv
  );
  configured = true;
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

// Categorías de notificación que el usuario puede activar/desactivar. "sistema"
// (p.ej. el push de prueba) no se filtra. Modelo opt-out: ausente/true = on.
export type NotifCategoria = "cfdis" | "declaraciones" | "revision" | "sistema";

/** ¿El usuario tiene activada esta categoría? Default: sí (opt-out). */
async function categoriaHabilitada(userId: string, categoria?: NotifCategoria): Promise<boolean> {
  if (!categoria || categoria === "sistema") return true;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { notifPrefs: true } });
  const prefs = (u?.notifPrefs ?? {}) as Record<string, boolean>;
  return prefs[categoria] !== false;
}

/**
 * Usuarios con acceso a una empresa (para notificar a TODOS los que la operan):
 * miembros directos (CompanyMember) ∪ miembros del despacho dueño (respetando
 * el scoping por empresa) ∪ operadores de plataforma. Antes sólo se notificaba
 * a CompanyMember, dejando fuera a contadores del despacho y al operador.
 */
export async function usuariosConAccesoACompany(companyId: string): Promise<string[]> {
  const ids = new Set<string>();

  const [company, direct, operadores] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { despachoId: true } }),
    prisma.companyMember.findMany({ where: { companyId }, select: { userId: true } }),
    prisma.user.findMany({ where: { esOperador: true }, select: { id: true } }),
  ]);
  direct.forEach((m) => ids.add(m.userId));
  operadores.forEach((o) => ids.add(o.id));

  if (company?.despachoId) {
    const dms = await prisma.despachoMember.findMany({
      where: { despachoId: company.despachoId },
      select: { id: true, userId: true },
    });
    for (const dm of dms) {
      const scopeCount = await prisma.despachoMemberCompany.count({ where: { despachoMemberId: dm.id } });
      if (scopeCount === 0) {
        ids.add(dm.userId); // sin scoping = ve todas las del despacho
      } else {
        const has = await prisma.despachoMemberCompany.findFirst({
          where: { despachoMemberId: dm.id, companyId },
        });
        if (has) ids.add(dm.userId);
      }
    }
  }
  return [...ids];
}

/** Send a push to every subscription a user has. Prunes dead endpoints. */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  categoria?: NotifCategoria
): Promise<{ sent: number; configured: boolean }> {
  if (!ensureConfigured()) return { sent: 0, configured: false };
  if (!(await categoriaHabilitada(userId, categoria))) return { sent: 0, configured: true };
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload)
        );
        sent++;
      } catch (err: unknown) {
        const code = (err as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) {
          // Endpoint gone — drop the stale subscription.
          await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
        }
      }
    })
  );
  return { sent, configured: true };
}

/** Send a push to everyone with access to a company (members + despacho + operadores). */
export async function sendPushToCompany(
  companyId: string,
  payload: PushPayload,
  categoria?: NotifCategoria
): Promise<{ sent: number; configured: boolean }> {
  if (!ensureConfigured()) return { sent: 0, configured: false };
  const userIds = await usuariosConAccesoACompany(companyId);
  let sent = 0;
  for (const userId of userIds) {
    const r = await sendPushToUser(userId, payload, categoria);
    sent += r.sent;
  }
  return { sent, configured: true };
}
