"use client";

import { useState } from "react";
import { KeyRound, Loader2, CheckCircle2 } from "lucide-react";

// Cambio de contraseña self-serve (usuario con sesión). Pide la contraseña
// actual — POST /api/auth/change-password ya la exige para que una sesión
// robada no pueda cambiarla a ciegas.
export function CambiarPassword() {
  const [current, setCurrent] = useState("");
  const [nueva, setNueva] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);

  const inputCls =
    "w-full rounded-lg border border-cos-line bg-cos-canvas px-3 py-2 text-sm text-cos-ink " +
    "placeholder:text-cos-ink-faint focus:border-cos-brand focus:outline-none focus:ring-2 focus:ring-cos-brand/20";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (nueva !== confirm) {
      setError("La contraseña nueva y su confirmación no coinciden.");
      return;
    }
    setBusy(true);
    setError("");
    setOk(false);
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: current, newPassword: nueva }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "No se pudo cambiar la contraseña.");
      return;
    }
    setOk(true);
    setCurrent(""); setNueva(""); setConfirm("");
  }

  return (
    <div className="bg-cos-card border border-cos-line rounded-xl p-6 mt-6">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-cos-ink">
        <KeyRound className="h-4 w-4 text-cos-brand" /> Cambiar contraseña
      </h2>
      <form onSubmit={handleSubmit} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-cos-ink-soft">Contraseña actual</span>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)}
            required autoComplete="current-password" className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-cos-ink-soft">Nueva (mín. 8)</span>
          <input type="password" value={nueva} onChange={(e) => setNueva(e.target.value)}
            required minLength={8} autoComplete="new-password" className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-cos-ink-soft">Confírmala</span>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            required minLength={8} autoComplete="new-password" className={inputCls} />
        </label>
        {error && (
          <p className="sm:col-span-3 rounded-lg border border-cos-red-ink/20 bg-cos-red-tint px-3 py-2 text-[13px] text-cos-red-ink">
            {error}
          </p>
        )}
        {ok && (
          <p className="sm:col-span-3 flex items-center gap-1.5 rounded-lg border border-cos-jade-ink/20 bg-cos-jade-tint px-3 py-2 text-[13px] text-cos-jade-ink">
            <CheckCircle2 className="h-4 w-4" /> Contraseña actualizada. Úsala en tu próximo inicio de sesión.
          </p>
        )}
        <div className="sm:col-span-3">
          <button type="submit" disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-cos-brand px-4 py-2 text-sm font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? "Guardando…" : "Cambiar contraseña"}
          </button>
        </div>
      </form>
    </div>
  );
}
