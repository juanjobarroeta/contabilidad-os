"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { BrandMark, ThemeToggle } from "@/components/ui";
import { Loader2, KeyRound, CheckCircle2 } from "lucide-react";

// Página PÚBLICA de restablecimiento: llega con ?token= (enlace de un solo uso,
// 30 min, generado por el admin de plataforma). Misma arquitectura de tema que
// login/signup (tokens de tema, nunca fondos fijos).

function ResetPasswordInner() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token") ?? "");
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setLoading(true);
    setError("");
    const res = await fetch("/api/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error ?? "No se pudo restablecer la contraseña.");
      setLoading(false);
      return;
    }
    setDone(true);
  }

  const inputCls =
    "w-full rounded-lg border border-cos-line bg-cos-canvas px-3.5 py-2.5 text-[15px] text-cos-ink " +
    "placeholder:text-cos-ink-faint focus:border-cos-brand focus:outline-none focus:ring-2 focus:ring-cos-brand/25";

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-cos-canvas px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-[420px]">
        <div className="mb-6 flex items-center justify-center gap-2">
          <BrandMark size={26} className="text-cos-brand" />
          <span className="text-[19px] font-bold tracking-[-0.02em] text-cos-ink">
            Contabilidad<span className="text-cos-brand">OS</span>
          </span>
        </div>

        <div className="rounded-2xl border border-cos-line bg-cos-card p-7 shadow-card">
          {done ? (
            <div className="text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-cos-jade-ink" />
              <h1 className="mt-3 text-[20px] font-bold text-cos-ink">Contraseña actualizada</h1>
              <p className="mt-1 text-[14px] text-cos-ink-soft">Ya puedes entrar con tu nueva contraseña.</p>
              <Link href="/login"
                className="mt-5 inline-flex w-full items-center justify-center rounded-lg bg-cos-brand py-2.5 text-[15px] font-semibold text-white hover:bg-cos-brand-deep">
                Iniciar sesión
              </Link>
            </div>
          ) : (
            <>
              <div className="mb-6">
                <h1 className="flex items-center gap-2 text-[22px] font-bold tracking-[-0.02em] text-cos-ink">
                  <KeyRound className="h-5 w-5 text-cos-brand" /> Nueva contraseña
                </h1>
                <p className="mt-1 text-[14px] text-cos-ink-soft">
                  Este enlace es de un solo uso y dura 30 minutos.
                </p>
              </div>

              {!token && (
                <p className="mb-4 rounded-lg border border-cos-amber-ink/20 bg-cos-amber-tint px-3 py-2 text-[13px] text-cos-amber-ink">
                  Falta el token del enlace. Abre el enlace completo que te compartieron.
                </p>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="password" className="mb-1.5 block text-[13px] font-semibold text-cos-ink">
                    Nueva contraseña
                  </label>
                  <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                    required minLength={8} autoComplete="new-password" className={inputCls} placeholder="Mínimo 8 caracteres" />
                </div>
                <div>
                  <label htmlFor="confirm" className="mb-1.5 block text-[13px] font-semibold text-cos-ink">
                    Confírmala
                  </label>
                  <input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                    required minLength={8} autoComplete="new-password" className={inputCls} placeholder="Repite la contraseña" />
                </div>

                {error && (
                  <p className="rounded-lg border border-cos-red-ink/20 bg-cos-red-tint px-3 py-2 text-[13px] text-cos-red-ink">
                    {error}
                  </p>
                )}

                <button type="submit" disabled={loading || !token}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-cos-brand py-2.5 text-[15px] font-semibold text-white transition-colors hover:bg-cos-brand-deep disabled:opacity-50">
                  {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                  {loading ? "Guardando…" : "Restablecer contraseña"}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="mt-5 text-center text-[14px] text-cos-ink-soft">
          ¿La recordaste?{" "}
          <Link href="/login" className="font-semibold text-cos-brand-ink hover:underline">Inicia sesión</Link>
        </p>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordInner />
    </Suspense>
  );
}
