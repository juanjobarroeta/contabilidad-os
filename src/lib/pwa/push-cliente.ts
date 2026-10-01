// ─────────────────────────────────────────────────────────────────────────────
// Activar las notificaciones push del navegador (PWA + escritorio). Lo usan el
// botón flotante (PushOptIn) y el alta («¿Te aviso cuando termine?»). El
// permiso sólo se pide con un clic explícito; nunca solo.
// ─────────────────────────────────────────────────────────────────────────────

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

export type EstadoPush = "unsupported" | "denied" | "idle" | "enabled";

// VAPID public key (base64url) → Uint8Array for PushManager.subscribe.
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function soportado(): boolean {
  return (
    !!VAPID_PUBLIC_KEY &&
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** ¿Ya hay suscripción? Sin pedir permiso. */
export async function estadoPush(): Promise<EstadoPush> {
  if (!soportado()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.pushManager.getSubscription()) ? "enabled" : "idle";
  } catch {
    return "idle";
  }
}

/** Pide permiso, suscribe y registra en el servidor. Devuelve el estado final. */
export async function activarPush(companyId: string | null, opts: { probar?: boolean } = {}): Promise<EstadoPush> {
  if (!soportado()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "idle";
  // Register the SW ourselves — ServiceWorkerRegister attaches to the `load`
  // event, which is often already fired by the time React hydrates, leaving
  // navigator.serviceWorker.ready pending forever. register() resolves
  // regardless and updates to the latest sw.js (with the push handler).
  await navigator.serviceWorker.register("/sw.js");
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY!) as BufferSource,
    }));
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...sub.toJSON(), companyId }),
  });
  // Un push de prueba para que vea que funciona.
  if (res.ok && opts.probar !== false) fetch("/api/push/test", { method: "POST" }).catch(() => {});
  return res.ok ? "enabled" : "idle";
}
