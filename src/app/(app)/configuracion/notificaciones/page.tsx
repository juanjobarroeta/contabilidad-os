"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, Loader2, Check, AlertCircle } from "lucide-react";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type Estado = "checking" | "unsupported" | "denied" | "off" | "on" | "working";
type Prefs = { cfdis: boolean; declaraciones: boolean };

const CATS: { key: keyof Prefs; titulo: string; desc: string }[] = [
  { key: "cfdis", titulo: "Facturas nuevas (CFDI)", desc: "Cuando la sincronización con el SAT trae CFDIs nuevos." },
  { key: "declaraciones", titulo: "Acuses por capturar", desc: "Recordatorio de declaraciones faltantes por subir." },
];

export default function NotificacionesPage() {
  const [estado, setEstado] = useState<Estado>("checking");
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/push/prefs").then((r) => (r.ok ? r.json() : null)).then((p) => p && setPrefs(p));
    if (!VAPID_PUBLIC_KEY) { setEstado("unsupported"); return; }
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setEstado("unsupported");
      return;
    }
    if (Notification.permission === "denied") { setEstado("denied"); return; }
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setEstado(sub ? "on" : "off"))
      .catch(() => setEstado("off"));
  }, []);

  async function activar() {
    if (!VAPID_PUBLIC_KEY) return;
    setEstado("working");
    setMsg(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setEstado(permission === "denied" ? "denied" : "off"); return; }
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
        body: JSON.stringify(sub.toJSON()),
      });
      setEstado(res.ok ? "on" : "off");
      if (res.ok) {
        fetch("/api/push/test", { method: "POST" }).catch(() => {});
        setMsg("Notificaciones activadas — te enviamos una de prueba.");
      }
    } catch {
      setEstado("off");
      setMsg("No se pudo activar. Intenta de nuevo.");
    }
  }

  async function desactivar() {
    setEstado("working");
    setMsg(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch(`/api/push/subscribe?endpoint=${encodeURIComponent(sub.endpoint)}`, { method: "DELETE" });
        await sub.unsubscribe();
      }
      setEstado("off");
      setMsg("Notificaciones desactivadas en este dispositivo.");
    } catch {
      setEstado("on");
    }
  }

  async function togglePref(key: keyof Prefs) {
    if (!prefs) return;
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    await fetch("/api/push/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: next[key] }),
    }).catch(() => {});
  }

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold">Notificaciones</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Activa las notificaciones push y elige qué quieres recibir.
      </p>

      {/* Estado del dispositivo */}
      <div className="mt-6 rounded-xl border border-border bg-white p-5">
        <div className="flex items-center gap-3">
          {estado === "on" ? <Bell className="h-5 w-5 text-cos-brand-ink" /> : <BellOff className="h-5 w-5 text-muted-foreground" />}
          <div className="flex-1">
            <p className="font-semibold text-foreground">
              {estado === "on" ? "Activadas en este dispositivo" : "Desactivadas en este dispositivo"}
            </p>
            <p className="text-sm text-muted-foreground">
              {estado === "unsupported" && "Tu navegador no soporta push. En iPhone, instala la app a la pantalla de inicio (Compartir → Añadir a inicio) y ábrela desde ahí."}
              {estado === "denied" && "Bloqueaste las notificaciones. Habilítalas en los ajustes del navegador para este sitio."}
              {(estado === "off" || estado === "on" || estado === "working" || estado === "checking") &&
                "Las notificaciones llegan a este dispositivo. En iPhone requieren tener la app instalada en la pantalla de inicio."}
            </p>
          </div>
          {estado === "off" && (
            <button onClick={activar} className="rounded-control bg-cos-brand px-4 py-2 text-sm font-semibold text-white hover:bg-cos-brand-deep">
              Activar
            </button>
          )}
          {estado === "on" && (
            <button onClick={desactivar} className="rounded-control border border-border px-4 py-2 text-sm font-medium hover:bg-cos-paper">
              Desactivar
            </button>
          )}
          {estado === "working" && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
        </div>
        {msg && (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-cos-ink-soft">
            <Check className="h-4 w-4 text-cos-green-ink" /> {msg}
          </p>
        )}
        {(estado === "unsupported" || estado === "denied") && (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-cos-amber-ink">
            <AlertCircle className="h-4 w-4" /> No se pueden activar aquí ahora.
          </p>
        )}
      </div>

      {/* Categorías */}
      <div className="mt-5 rounded-xl border border-border bg-white">
        <div className="border-b border-border px-5 py-3">
          <p className="font-semibold text-foreground">¿Qué quieres recibir?</p>
        </div>
        <ul className="divide-y divide-border">
          {CATS.map((c) => {
            const on = prefs?.[c.key] ?? true;
            return (
              <li key={c.key} className="flex items-center gap-3 px-5 py-4">
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">{c.titulo}</p>
                  <p className="text-xs text-muted-foreground">{c.desc}</p>
                </div>
                <button
                  role="switch"
                  aria-checked={on}
                  onClick={() => togglePref(c.key)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-cos-brand" : "bg-cos-line"}`}
                >
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Las categorías aplican a todos tus dispositivos. El interruptor de arriba activa/desactiva sólo este.
      </p>
    </div>
  );
}
