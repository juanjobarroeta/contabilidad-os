"use client";

import { useEffect, useState } from "react";
import {
  MessageCircle,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Building2,
  Unlink,
} from "lucide-react";

type WhatsappLink = {
  id: string;
  phoneE164: string;
  verifiedAt: string | null;
  createdAt: string;
};

type LinkState = {
  links: WhatsappLink[];
  available: boolean;
  companyCount: number;
  digestOptIn: boolean;
};

/** Masks a phone, keeping the country prefix and the last two digits. */
function maskPhone(e164: string): string {
  const digits = e164.replace(/[^\d+]/g, "");
  if (digits.length <= 5) return digits;
  const head = digits.slice(0, 3);
  const tail = digits.slice(-2);
  return `${head} ${"•".repeat(Math.max(2, digits.length - 5))} ${tail}`;
}

/**
 * Per-user WhatsApp linking. The phone↔account binding is what the WhatsApp
 * channel trusts (caller ID alone never authorizes), so verification is via a
 * 6-digit code we send over WhatsApp.
 */
export function WhatsappLinkCard() {
  const [state, setState] = useState<LinkState | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<"idle" | "code_sent">("idle");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [savingDigest, setSavingDigest] = useState(false);

  async function loadState() {
    try {
      const res = await fetch("/api/whatsapp/link");
      if (res.ok) {
        setState((await res.json()) as LinkState);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadState();
  }, []);

  const verifiedLink = state?.links.find((l) => l.verifiedAt) ?? null;
  const isDespacho = (state?.companyCount ?? 0) > 1;

  async function startLink() {
    setError("");
    setInfo("");
    if (!phone.trim()) {
      setError("Ingresa tu número con lada (ej. +52 55 1234 5678).");
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
        setError(data.error ?? "No se pudo enviar el código.");
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
      setError("El código son 6 dígitos.");
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
        setError(data.error ?? "Código incorrecto.");
        return;
      }
      setPhase("idle");
      setPhone("");
      setCode("");
      setInfo("Número vinculado. Ya puedes consultar tu contabilidad por WhatsApp.");
      await loadState();
    } catch {
      setError("Error de red. Inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  async function unlink(target: WhatsappLink) {
    if (
      !confirm(
        "¿Desvincular este número? Dejará de tener acceso a tu contabilidad por WhatsApp."
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/whatsapp/link", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: target.phoneE164 }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "No se pudo desvincular.");
        return;
      }
      setInfo("Número desvinculado.");
      await loadState();
    } catch {
      setError("Error de red. Inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleDigest() {
    if (!state) return;
    const next = !state.digestOptIn;
    setState({ ...state, digestOptIn: next });
    setSavingDigest(true);
    try {
      const res = await fetch("/api/whatsapp/link", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digestOptIn: next }),
      });
      if (!res.ok) {
        // Revert on failure.
        setState((s) => (s ? { ...s, digestOptIn: !next } : s));
      }
    } catch {
      setState((s) => (s ? { ...s, digestOptIn: !next } : s));
    } finally {
      setSavingDigest(false);
    }
  }

  function reset() {
    setPhase("idle");
    setCode("");
    setError("");
    setInfo("");
  }

  return (
    <div className="rounded-card border border-cos-line bg-cos-card p-6 shadow-card">
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-cos-jade-tint text-cos-jade-ink">
          <MessageCircle className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold text-cos-ink">WhatsApp</h2>
            {!loading && <AvailabilityBadge available={state?.available ?? false} />}
          </div>
          <p className="mt-0.5 text-sm text-cos-ink-soft">
            Vincula tu número para consultar tu contabilidad por WhatsApp. Aplica a
            todas tus empresas.
          </p>

          {loading ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-cos-ink-soft">
              <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
            </div>
          ) : (
            <>
              {/* Estado verificado */}
              {verifiedLink ? (
                <div className="mt-4 flex items-center justify-between gap-3 rounded-control border border-cos-line bg-cos-paper px-4 py-3">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-cos-jade-ink" />
                    <div>
                      <p className="text-sm font-medium text-cos-ink">Vinculado</p>
                      <p className="font-mono text-xs text-cos-ink-soft">
                        {maskPhone(verifiedLink.phoneE164)}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => unlink(verifiedLink)}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-control border border-cos-line px-3 py-1.5 text-xs font-medium text-cos-ink-soft hover:bg-cos-card disabled:opacity-50"
                  >
                    <Unlink className="h-3.5 w-3.5" /> Desvincular
                  </button>
                </div>
              ) : (
                /* Flujo de vinculación (idle / código enviado) */
                <div className="mt-4 border-t border-cos-line pt-4">
                  {phase === "idle" ? (
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        type="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="+52 55 1234 5678"
                        disabled={!state?.available}
                        className="flex-1 rounded-control border border-cos-line bg-cos-card px-3 py-2 font-mono text-sm text-cos-ink focus:outline-none focus:ring-2 focus:ring-cos-brand/30 disabled:opacity-60"
                      />
                      <button
                        type="button"
                        onClick={startLink}
                        disabled={busy || !state?.available}
                        className="inline-flex items-center justify-center gap-2 rounded-control bg-cos-brand px-4 py-2 text-sm font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Enviar código
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col items-start gap-2 sm:flex-row">
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                        placeholder="6 dígitos"
                        className="w-32 rounded-control border border-cos-line bg-cos-card px-3 py-2 font-mono text-sm tracking-widest text-cos-ink focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
                      />
                      <button
                        type="button"
                        onClick={verify}
                        disabled={busy}
                        className="inline-flex items-center justify-center gap-2 rounded-control bg-cos-brand px-4 py-2 text-sm font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Verificar
                      </button>
                      <button
                        type="button"
                        onClick={reset}
                        className="rounded-control border border-cos-line px-3 py-2 text-sm text-cos-ink-soft hover:bg-cos-paper"
                      >
                        Cancelar
                      </button>
                    </div>
                  )}
                </div>
              )}

              {error && (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-cos-red-ink">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
                </p>
              )}
              {info && (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-cos-jade-ink">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> {info}
                </p>
              )}

              {!state?.available && (
                <p className="mt-3 text-xs text-cos-ink-soft">
                  El canal de WhatsApp aún no está configurado en el servidor.
                  Podrás vincular tu número cuando esté disponible.
                </p>
              )}

              {/* Contexto de despacho (multi-empresa) */}
              {isDespacho && (
                <div className="mt-4 flex items-start gap-3 rounded-control border border-cos-line bg-cos-paper px-4 py-3">
                  <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-cos-brand-ink" />
                  <p className="text-xs text-cos-ink-soft">
                    El asistente puede responder sobre cualquiera de tus{" "}
                    {state?.companyCount} empresas por WhatsApp. Para cambiar de
                    empresa, nómbrala en tu mensaje (por ejemplo, &ldquo;cámbiate a
                    Aceros del Norte&rdquo;).
                  </p>
                </div>
              )}

              {/* Resumen diario — solo despacho (multi-empresa) y número vinculado */}
              {isDespacho && verifiedLink && (
                <div className="mt-3 flex items-center gap-3 rounded-control border border-cos-line px-4 py-3">
                  <div className="flex-1">
                    <p className="text-sm font-medium text-cos-ink">
                      Resumen diario de mi cartera por WhatsApp
                    </p>
                    <p className="text-xs text-cos-ink-soft">
                      Recibe cada día un resumen del estado de todas tus empresas.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={state?.digestOptIn ?? false}
                    aria-label="Recibir un resumen diario de mi cartera por WhatsApp"
                    onClick={toggleDigest}
                    disabled={savingDigest}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                      state?.digestOptIn ? "bg-cos-brand" : "bg-cos-line"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                        state?.digestOptIn ? "left-[22px]" : "left-0.5"
                      }`}
                    />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AvailabilityBadge({ available }: { available: boolean }) {
  return available ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-cos-jade-tint px-2 py-0.5 text-xs font-medium text-cos-jade-ink">
      <CheckCircle2 className="h-3 w-3" /> Disponible
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-cos-amber-tint px-2 py-0.5 text-xs font-medium text-cos-amber-ink">
      No configurado aún
    </span>
  );
}
