"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BrandMark, ThemeToggle } from "@/components/ui";
import { rutaRetornoSegura } from "@/lib/ruta-retorno";
import { Loader2, ShieldCheck, CreditCard, CalendarClock, Gift, Sparkles } from "lucide-react";

type InvitePreview =
  | { valida: true; despachoName: string; ownerNombre: string | null; syntage: boolean; sinCargo: boolean; maxEmpresas: number | null }
  | { valida: false; mensaje?: string };

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Invitación: del enlace (?invite=) o tecleada como código. Se previsualiza
  // para mostrar el banner de condiciones antes de registrarse.
  const [inviteToken, setInviteToken] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  // A dónde volver tras crear la cuenta. La página de invitación de CLIENTE
  // manda `?callbackUrl=/invitacion/<token>`: ignorarlo (como pasaba) dejaba al
  // invitado sin aceptar su invitación, sin membresía, y el wizard le pedía
  // crear una empresa y contratar un plan que su despacho ya paga.
  const [callbackUrl, setCallbackUrl] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("invite");
    if (t) { setInviteToken(t); setCodeInput(t); }
    setCallbackUrl(rutaRetornoSegura(params.get("callbackUrl")));
    // El correo invitado llega prellenado — la invitación sólo la puede aceptar
    // ese correo, así que teclear otro es garantía de rebote.
    const em = params.get("email");
    if (em) setEmail(em);
  }, []);

  useEffect(() => {
    const t = inviteToken.trim();
    if (!t) { setPreview(null); return; }
    let vivo = true;
    fetch(`/api/onboarding-invites/preview?token=${encodeURIComponent(t)}`)
      .then((r) => r.json())
      .then((d) => { if (vivo) { setPreview(d); if (d.valida && d.ownerNombre) setName((n) => n || d.ownerNombre); } })
      .catch(() => { if (vivo) setPreview(null); });
    return () => { vivo = false; };
  }, [inviteToken]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password, ...(inviteToken.trim() ? { inviteToken: inviteToken.trim() } : {}) }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "No se pudo crear la cuenta");
      setLoading(false);
      return;
    }

    const signInRes = await signIn("credentials", { email, password, redirect: false });
    if (signInRes?.error) {
      setError("Cuenta creada, pero no pudimos iniciar sesión. Intenta entrar manualmente.");
      setLoading(false);
      return;
    }
    // Con callbackUrl (p. ej. aceptar una invitación de cliente) se vuelve ahí;
    // sin él, el destino de siempre: configurar la primera empresa.
    router.push(callbackUrl ?? "/onboarding");
  }

  // Input compartido: usa tokens de tema (fondo/tinta) para que SIEMPRE
  // contraste — el bug anterior era fondo blanco fijo con tinta de tema que se
  // volvía casi blanca en modo oscuro del sistema.
  const inputCls =
    "w-full rounded-lg border border-cos-line bg-cos-canvas px-3.5 py-2.5 text-[15px] text-cos-ink " +
    "placeholder:text-cos-ink-faint focus:border-cos-brand focus:outline-none focus:ring-2 focus:ring-cos-brand/25";

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-cos-canvas px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-[420px]">
        {/* marca */}
        <div className="mb-6 flex items-center justify-center gap-2">
          <BrandMark size={26} className="text-cos-brand" />
          <span className="text-[19px] font-bold tracking-[-0.02em] text-cos-ink">
            Contabilidad<span className="text-cos-brand">OS</span>
          </span>
        </div>

        <div className="rounded-2xl border border-cos-line bg-cos-card p-7 shadow-card">
          <div className="mb-6">
            <h1 className="text-[24px] font-bold tracking-[-0.02em] text-cos-ink">Crea tu cuenta</h1>
            <p className="mt-1 text-[14px] text-cos-ink-soft">
              Tu contador con IA para el SAT. Empieza en un minuto.
            </p>
          </div>

          {/* Banner de invitación (enlace o código válido) */}
          {preview?.valida && (
            <div className="mb-5 rounded-xl border border-cos-jade-ink/25 bg-cos-jade-tint px-4 py-3">
              <p className="flex items-center gap-2 text-[13.5px] font-semibold text-cos-jade-ink">
                <Gift className="h-4 w-4" /> Invitación para {preview.despachoName}
              </p>
              <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] text-cos-jade-ink/90">
                {preview.sinCargo && <span className="inline-flex items-center gap-1"><CreditCard className="h-3.5 w-3.5" /> Sin cargo</span>}
                {preview.syntage && <span className="inline-flex items-center gap-1"><Sparkles className="h-3.5 w-3.5" /> Sincronización SAT (Syntage) incluida</span>}
                {preview.maxEmpresas != null && <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> Hasta {preview.maxEmpresas} empresa{preview.maxEmpresas === 1 ? "" : "s"}</span>}
              </p>
            </div>
          )}
          {preview && !preview.valida && codeInput.trim() && (
            <p className="mb-4 rounded-lg border border-cos-amber-ink/20 bg-cos-amber-tint px-3 py-2 text-[12.5px] text-cos-amber-ink">
              {preview.mensaje ?? "La invitación no es válida."}
            </p>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="name" className="mb-1.5 block text-[13px] font-semibold text-cos-ink">
                Tu nombre
              </label>
              <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)}
                required autoComplete="name" className={inputCls} placeholder="Juan Pérez" />
            </div>

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
                required minLength={8} autoComplete="new-password" className={inputCls} placeholder="Mínimo 8 caracteres" />
            </div>

            {/* Código de invitación manual — sólo si no llegó por enlace */}
            {!inviteToken && (
              <details className="rounded-lg border border-cos-line px-3 py-2">
                <summary className="cursor-pointer text-[12.5px] font-medium text-cos-ink-soft">
                  ¿Tienes un código de invitación?
                </summary>
                <div className="mt-2 flex gap-2">
                  <input type="text" value={codeInput} onChange={(e) => setCodeInput(e.target.value)}
                    placeholder="Pega tu código" className={inputCls + " font-mono text-[13px]"} />
                  <button type="button" onClick={() => setInviteToken(codeInput.trim())}
                    className="rounded-lg border border-cos-line px-3 text-[13px] font-medium text-cos-brand-ink hover:bg-cos-brand-tint">
                    Aplicar
                  </button>
                </div>
              </details>
            )}

            {error && (
              <p className="rounded-lg border border-cos-red-ink/20 bg-cos-red-tint px-3 py-2 text-[13px] text-cos-red-ink">
                {error}
              </p>
            )}

            <button type="submit" disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-cos-brand py-2.5 text-[15px] font-semibold text-white transition-colors hover:bg-cos-brand-deep disabled:opacity-50">
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? "Creando cuenta…" : "Empezar prueba gratis"}
            </button>

            <p className="text-center text-[12px] leading-relaxed text-cos-ink-faint">
              Al crear tu cuenta aceptas los{" "}
              <Link href="/legal/terminos" className="font-medium text-cos-brand-ink hover:underline">Términos y Condiciones</Link>{" "}
              y el{" "}
              <Link href="/legal/aviso-de-privacidad" className="font-medium text-cos-brand-ink hover:underline">Aviso de Privacidad</Link>.
            </p>
          </form>

          {/* señales de confianza */}
          <div className="mt-5 flex flex-wrap justify-center gap-x-4 gap-y-1.5 border-t border-cos-line pt-4 text-[12px] text-cos-ink-soft">
            <span className="inline-flex items-center gap-1.5"><CalendarClock className="h-3.5 w-3.5 text-cos-jade-ink" /> 15 días gratis</span>
            <span className="inline-flex items-center gap-1.5"><CreditCard className="h-3.5 w-3.5 text-cos-jade-ink" /> Sin tarjeta</span>
            <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-cos-jade-ink" /> Cancela cuando quieras</span>
          </div>
        </div>

        <p className="mt-5 text-center text-[14px] text-cos-ink-soft">
          ¿Ya tienes cuenta?{" "}
          <Link href="/login" className="font-semibold text-cos-brand-ink hover:underline">Inicia sesión</Link>
        </p>
      </div>
    </div>
  );
}
