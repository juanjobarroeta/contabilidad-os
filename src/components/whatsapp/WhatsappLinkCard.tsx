"use client";

import { useEffect, useState } from "react";
import { MessageCircle, CheckCircle2, Loader2 } from "lucide-react";

type WhatsappLink = {
  id: string;
  phoneE164: string;
  verifiedAt: string | null;
  createdAt: string;
};

/**
 * Per-user WhatsApp linking. The phone↔account binding is what the WhatsApp
 * channel trusts (caller ID alone never authorizes), so verification is via a
 * 6-digit code we send over WhatsApp.
 */
export function WhatsappLinkCard() {
  const [links, setLinks] = useState<WhatsappLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<"idle" | "code_sent">("idle");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  async function loadLinks() {
    try {
      const res = await fetch("/api/whatsapp/link");
      if (res.ok) {
        const data = await res.json();
        setLinks(data.links ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLinks();
  }, []);

  async function startLink() {
    setError("");
    setInfo("");
    if (!phone.trim()) {
      setError("Ingresa tu número con lada (ej. +52 55 1234 5678)");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/whatsapp/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "No se pudo enviar el código");
        return;
      }
      setPhase("code_sent");
      setInfo("Te enviamos un código por WhatsApp. Revisa tu teléfono.");
    } catch {
      setError("Error de red. Inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setError("");
    setInfo("");
    if (code.trim().length !== 6) {
      setError("El código son 6 dígitos");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/whatsapp/link/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Código incorrecto");
        return;
      }
      setPhase("idle");
      setPhone("");
      setCode("");
      setInfo("¡Número vinculado! Ya puedes escribirle a tu contador por WhatsApp.");
      await loadLinks();
    } catch {
      setError("Error de red. Inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPhase("idle");
    setCode("");
    setError("");
    setInfo("");
  }

  return (
    <div className="bg-white border border-cos-line rounded-xl p-6 mt-6">
      <div className="flex items-start gap-4">
        <div className="h-12 w-12 rounded-full bg-green-100 text-green-700 flex items-center justify-center shrink-0">
          <MessageCircle className="h-6 w-6" />
        </div>
        <div className="flex-1">
          <h2 className="font-semibold">WhatsApp</h2>
          <p className="text-sm text-cos-ink-soft mt-0.5">
            Vincula tu número para consultar tu contabilidad por WhatsApp. Aplica a todas tus empresas.
          </p>

          {/* Existing links */}
          {loading ? (
            <div className="mt-4 text-sm text-cos-ink-soft flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
            </div>
          ) : links.length > 0 ? (
            <ul className="mt-4 space-y-2">
              {links.map((l) => (
                <li
                  key={l.id}
                  className="flex items-center justify-between border border-cos-line rounded-lg px-3 py-2 text-sm"
                >
                  <span className="font-mono">{l.phoneE164}</span>
                  {l.verifiedAt ? (
                    <span className="inline-flex items-center gap-1 text-xs text-green-700 font-medium">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Verificado
                    </span>
                  ) : (
                    <span className="text-xs text-amber-600 font-medium">Pendiente de verificar</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}

          {/* Add / verify flow */}
          <div className="mt-4 border-t border-cos-line pt-4">
            {phase === "idle" ? (
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+52 55 1234 5678"
                  className="flex-1 px-3 py-2 border border-cos-line rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
                />
                <button
                  type="button"
                  onClick={startLink}
                  disabled={busy}
                  className="inline-flex items-center justify-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep/90 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Enviar código
                </button>
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row gap-2 items-start">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="6 dígitos"
                  className="w-32 px-3 py-2 border border-cos-line rounded-md text-sm font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
                />
                <button
                  type="button"
                  onClick={verify}
                  disabled={busy}
                  className="inline-flex items-center justify-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep/90 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Verificar
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="px-3 py-2 rounded-md text-sm text-cos-ink-soft border border-cos-line hover:bg-cos-paper"
                >
                  Cancelar
                </button>
              </div>
            )}

            {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
            {info && <p className="text-xs text-green-700 mt-2">{info}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
