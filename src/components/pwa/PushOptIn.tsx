"use client";

import { useEffect, useState } from "react";
import { Bell, Loader2, Check } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

// VAPID public key (base64url) → Uint8Array for PushManager.subscribe.
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type State = "checking" | "unsupported" | "idle" | "enabling" | "enabled" | "denied";

/** Small, dismissible opt-in to enable Web Push (PWA + desktop). Permission is
 *  only requested on an explicit click — never auto-prompted. Self-hides once
 *  enabled, denied, unsupported, or if VAPID isn't configured. */
export function PushOptIn() {
  const { activeCompany } = useCompany();
  const [state, setState] = useState<State>("checking");

  useEffect(() => {
    if (!VAPID_PUBLIC_KEY) { setState("unsupported"); return; }
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") { setState("denied"); return; }
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setState(sub ? "enabled" : "idle"))
      .catch(() => setState("idle"));
  }, []);

  async function enable() {
    if (!VAPID_PUBLIC_KEY) return;
    setState("enabling");
    // Watchdog: never spin forever — if something stalls, reset so the user
    // can retry (and we log why).
    const watchdog = setTimeout(() => {
      console.error("[push] activación tardó demasiado; reinicia y reintenta.");
      setState("idle");
    }, 20000);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "idle");
        return;
      }
      // Register the SW ourselves — ServiceWorkerRegister attaches to the
      // `load` event, which is often already fired by the time React hydrates,
      // leaving navigator.serviceWorker.ready pending forever. register()
      // resolves regardless and updates to the latest sw.js (with the push
      // handler), which skipWaiting/claim activate immediately.
      await navigator.serviceWorker.register("/sw.js");
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
        }));
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...sub.toJSON(), companyId: activeCompany?.id ?? null }),
      });
      setState(res.ok ? "enabled" : "idle");
      // Fire a one-off confirmation push so the user sees it works immediately.
      if (res.ok) fetch("/api/push/test", { method: "POST" }).catch(() => {});
    } catch (err) {
      console.error("[push] no se pudo activar:", err);
      setState("idle");
    } finally {
      clearTimeout(watchdog);
    }
  }

  if (state === "checking" || state === "unsupported" || state === "denied" || state === "enabled") return null;

  return (
    <button
      onClick={enable}
      disabled={state === "enabling"}
      className="fixed bottom-6 left-6 z-40 inline-flex items-center gap-2 rounded-control border border-cos-line bg-white px-4 py-2.5 text-[13.5px] font-semibold text-cos-ink shadow-card hover:bg-cos-paper disabled:opacity-60 max-md:bottom-20"
    >
      {state === "enabling" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4 text-cos-brand-ink" />}
      Activar notificaciones
    </button>
  );
}
