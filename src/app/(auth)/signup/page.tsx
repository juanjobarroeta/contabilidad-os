"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "No se pudo crear la cuenta");
      setLoading(false);
      return;
    }

    // Auto sign-in then go to onboarding
    const signInRes = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    if (signInRes?.error) {
      setError("Cuenta creada, pero no pudimos iniciar sesión. Intenta entrar manualmente.");
      setLoading(false);
      return;
    }

    router.push("/onboarding");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-xl shadow-sm border border-cos-line p-8">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-cos-ink">Crea tu cuenta</h1>
            <p className="text-cos-ink-soft text-sm mt-1">
              15 días gratis. Sin tarjeta de crédito.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-cos-ink mb-1">
                Tu nombre
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand"
                placeholder="Juan Pérez"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-cos-ink mb-1">
                Correo electrónico
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand"
                placeholder="tu@empresa.com"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-cos-ink mb-1">
                Contraseña
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand"
                placeholder="Mínimo 8 caracteres"
              />
            </div>

            {error && <p className="text-sm text-cos-red-ink">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-cos-brand text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-cos-brand-deep/90 transition-colors disabled:opacity-50"
            >
              {loading ? "Creando cuenta..." : "Empezar prueba gratis"}
            </button>

            <p className="text-xs text-cos-ink-soft text-center">
              Al crear tu cuenta aceptas los{" "}
              <Link href="/legal/terminos" className="text-cos-brand-ink hover:underline">
                Términos y Condiciones
              </Link>{" "}
              y el{" "}
              <Link href="/legal/aviso-de-privacidad" className="text-cos-brand-ink hover:underline">
                Aviso de Privacidad
              </Link>
              .
            </p>
          </form>

          <p className="text-sm text-cos-ink-soft mt-6 text-center">
            ¿Ya tienes cuenta?{" "}
            <Link href="/login" className="text-cos-brand-ink hover:underline">
              Inicia sesión
            </Link>
          </p>
        </div>

        <p className="text-xs text-cos-ink-faint mt-4 text-center">
          <Link href="/legal/aviso-de-privacidad" className="hover:text-cos-brand-ink hover:underline">
            Aviso de Privacidad
          </Link>
          {" · "}
          <Link href="/legal/terminos" className="hover:text-cos-brand-ink hover:underline">
            Términos y Condiciones
          </Link>
        </p>
      </div>
    </div>
  );
}
