"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    if (res?.error) {
      setError("Correo o contraseña incorrectos");
      setLoading(false);
    } else {
      router.push("/dashboard");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-xl shadow-sm border border-cos-line p-8">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-cos-ink">ContabilidadOS</h1>
            <p className="text-cos-ink-soft text-sm mt-1">
              Sistema contable y fiscal mexicano
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
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
                className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <p className="text-sm text-cos-red-ink">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-cos-brand text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-cos-brand-deep/90 transition-colors disabled:opacity-50"
            >
              {loading ? "Iniciando sesión..." : "Iniciar sesión"}
            </button>
          </form>

          <p className="text-sm text-cos-ink-soft mt-6 text-center">
            ¿No tienes cuenta?{" "}
            <Link href="/signup" className="text-cos-brand-ink hover:underline">
              Empieza tu prueba gratis
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
