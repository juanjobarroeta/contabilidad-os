"use client";

import { useState } from "react";
import { Loader2, KeyRound, Link2, Check } from "lucide-react";

const inputCls =
  "w-full rounded-lg border border-cos-line bg-cos-card px-3 py-2 text-sm text-cos-ink focus:border-cos-brand focus:outline-none focus:ring-2 focus:ring-cos-brand/20";

export function ResetPasswordAdminClient() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resultado, setResultado] = useState<{ email: string; nombre: string | null; link: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function generar(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setResultado(null);
    try {
      const res = await fetch("/api/password-reset/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? "No se pudo generar el enlace"); return; }
      setResultado(data);
      setEmail("");
    } finally {
      setBusy(false);
    }
  }

  async function copiar(texto: string) {
    await navigator.clipboard.writeText(texto);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="space-y-6">
      <form onSubmit={generar} className="rounded-card border border-cos-line bg-cos-card p-5 shadow-card">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-cos-ink-soft">Correo del usuario</span>
          <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            className={inputCls} placeholder="cliente@empresa.com" />
        </label>
        {error && <p className="mt-2 text-sm text-cos-red-ink">{error}</p>}
        <button type="submit" disabled={busy || !email.trim()}
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-cos-brand px-4 py-2 text-sm font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          Generar enlace
        </button>
      </form>

      {resultado && (
        <div className="rounded-card border border-cos-jade-ink/25 bg-cos-jade-tint p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-cos-jade-ink">
            <KeyRound className="h-4 w-4" /> Enlace listo para {resultado.nombre ?? resultado.email}
          </p>
          <p className="mt-1 text-xs text-cos-jade-ink/80">
            Un solo uso, vence en 30 minutos. Se muestra únicamente ahora — cópialo y compárteselo.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <input readOnly value={resultado.link}
              className="flex-1 rounded-lg border border-cos-jade-ink/20 bg-cos-card px-3 py-2 font-mono text-xs text-cos-ink" />
            <button onClick={() => copiar(resultado.link)}
              className="inline-flex items-center gap-1 rounded-lg border border-cos-jade-ink/30 px-3 py-2 text-xs font-medium text-cos-jade-ink hover:bg-cos-card">
              {copied ? <Check className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />} Copiar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
