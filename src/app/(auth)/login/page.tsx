"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BrandMark, ThemeToggle } from "@/components/ui";
import { rutaRetornoSegura } from "@/lib/ruta-retorno";
import { Loader2 } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // La página de aceptación de invitación manda aquí con
  // `?callbackUrl=/invitacion/<token>`. Ignorarlo (como pasaba) rompía el
  // círculo: el invitado iniciaba sesión, caía en /dashboard sin membresía y el
  // layout lo mandaba al wizard a "contratar un plan". Sólo rutas internas —
  // validado — porque un callbackUrl abierto en el login es un open redirect.
  const [callbackUrl, setCallbackUrl] = useState<string | null>(null);
  useEffect(() => {
    setCallbackUrl(rutaRetornoSegura(new URLSearchParams(window.location.search).get("callbackUrl")));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await signIn("credentials", { email, password, redirect: false });
    if (res?.error) {
      setError(
        res.code === "rate_limit"
          ? "Demasiados intentos. Intenta de nuevo más tarde."
          : "Correo o contraseña incorrectos"
      );
      setLoading(false);
    } else {
      router.push(callbackUrl ?? "/dashboard");
    }
  }

  // Fondo y tinta con tokens de tema para que contraste en claro Y oscuro
  // (el fondo blanco fijo anterior dejaba la tinta de tema casi invisible en
  // modo oscuro del sistema).
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
          <div className="mb-6">
            <h1 className="text-[24px] font-bold tracking-[-0.02em] text-cos-ink">Inicia sesión</h1>
            <p className="mt-1 text-[14px] text-cos-ink-soft">Bienvenido de vuelta.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="mb-1.5 block text-[13px] font-semibold text-cos-ink">
                Correo electrónico
              </label>
              <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                required autoComplete="email" className={inputCls} placeholder="tu@empresa.com" />
            </div>

            <div>
              <label htmlFor="password" className="mb-1.5 block text-[13px] font-semibold text-cos-ink">
                Contraseña
              </label>
              <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                required autoComplete="current-password" className={inputCls} placeholder="••••••••" />
            </div>

            {error && (
              <p className="rounded-lg border border-cos-red-ink/20 bg-cos-red-tint px-3 py-2 text-[13px] text-cos-red-ink">
                {error}
              </p>
            )}

            <button type="submit" disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-cos-brand py-2.5 text-[15px] font-semibold text-white transition-colors hover:bg-cos-brand-deep disabled:opacity-50">
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? "Iniciando sesión…" : "Iniciar sesión"}
            </button>
          </form>

          <p className="mt-6 text-center text-[14px] text-cos-ink-soft">
            ¿No tienes cuenta?{" "}
            <Link href="/signup" className="font-semibold text-cos-brand-ink hover:underline">Empieza tu prueba gratis</Link>
          </p>
        </div>

        <p className="mt-5 text-center text-[12px] text-cos-ink-faint">
          <Link href="/legal/aviso-de-privacidad" className="hover:text-cos-brand-ink hover:underline">Aviso de Privacidad</Link>
          {" · "}
          <Link href="/legal/terminos" className="hover:text-cos-brand-ink hover:underline">Términos y Condiciones</Link>
        </p>
      </div>
    </div>
  );
}
