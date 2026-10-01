"use client";

import { useEffect, useState } from "react";
import { Bell, Loader2, Check } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { activarPush, estadoPush } from "@/lib/pwa/push-cliente";

type State = "checking" | "unsupported" | "idle" | "enabling" | "enabled" | "denied";

/** Small, dismissible opt-in to enable Web Push (PWA + desktop). Permission is
 *  only requested on an explicit click — never auto-prompted. Self-hides once
 *  enabled, denied, unsupported, or if VAPID isn't configured. */
export function PushOptIn() {
  const { activeCompany } = useCompany();
  const [state, setState] = useState<State>("checking");

  useEffect(() => {
    void estadoPush().then(setState);
  }, []);

  async function enable() {
    setState("enabling");
    // Watchdog: never spin forever — if something stalls, reset so the user
    // can retry (and we log why).
    const watchdog = setTimeout(() => {
      console.error("[push] activación tardó demasiado; reinicia y reintenta.");
      setState("idle");
    }, 20000);
    try {
      setState(await activarPush(activeCompany?.id ?? null));
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
      className="fixed bottom-6 left-6 z-40 inline-flex items-center gap-2 rounded-control border border-cos-line bg-cos-card px-4 py-2.5 text-[13.5px] font-semibold text-cos-ink shadow-card hover:bg-cos-paper disabled:opacity-60 max-md:bottom-20"
    >
      {state === "enabling" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4 text-cos-brand-ink" />}
      Activar notificaciones
    </button>
  );
}
