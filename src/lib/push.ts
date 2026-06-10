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

/** Send a push to every subscription a user has. Prunes dead endpoints. */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<{ sent: number; configured: boolean }> {
  if (!ensureConfigured()) return { sent: 0, configured: false };
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

/** Send a push to every member of a company (de-duplicated across users). */
export async function sendPushToCompany(companyId: string, payload: PushPayload): Promise<{ sent: number; configured: boolean }> {
  if (!ensureConfigured()) return { sent: 0, configured: false };
  const members = await prisma.companyMember.findMany({
    where: { companyId },
    select: { userId: true },
  });
  const userIds = [...new Set(members.map((m) => m.userId))];
  let sent = 0;
  for (const userId of userIds) {
    const r = await sendPushToUser(userId, payload);
    sent += r.sent;
  }
  return { sent, configured: true };
}
