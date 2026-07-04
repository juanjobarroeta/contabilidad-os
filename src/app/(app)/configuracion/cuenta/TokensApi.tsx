"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, ShieldOff } from "lucide-react";

type TokenActivo = {
  id: string;
  etiqueta: string;
  scope: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  ip: string | null;
};

function fechaCorta(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("es-MX", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Accesos de API activos (refresh tokens de satélites) del usuario, con botón
 * «Revocar» por token y «Revocar todos». Revocar corta la renovación de
 * inmediato; el último access token emitido caduca solo en menos de una hora.
 * Autocontenido: consume GET/DELETE /api/me/tokens.
 */
export function TokensApi() {
  const [tokens, setTokens] = useState<TokenActivo[] | null>(null);
  const [error, setError] = useState("");
  const [ocupadoId, setOcupadoId] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/me/tokens");
      if (!res.ok) throw new Error("No se pudieron cargar los accesos");
      const data = await res.json();
      setTokens(Array.isArray(data.tokens) ? data.tokens : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
      setTokens([]);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function revocar(body: { id?: string; todos?: boolean }) {
    setOcupadoId(body.id ?? "todos");
    setError("");
    try {
      const res = await fetch("/api/me/tokens", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "No se pudo revocar el acceso");
      }
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setOcupadoId(null);
    }
  }

  return (
    <section className="bg-cos-card border border-cos-line rounded-xl shadow-sm p-5 mt-5">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-semibold text-sm flex items-center gap-2">
          <KeyRound className="h-4 w-4" />
          Accesos de API (aplicaciones conectadas)
        </h2>
        {tokens !== null && tokens.length > 1 && (
          <button
            onClick={() => revocar({ todos: true })}
            disabled={ocupadoId !== null}
            className="flex items-center gap-1.5 text-xs text-cos-red-ink border border-cos-red-ink/40 px-2.5 py-1 rounded-md hover:bg-cos-red-tint disabled:opacity-50"
          >
            {ocupadoId === "todos" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldOff className="h-3.5 w-3.5" />
            )}
            Revocar todos
          </button>
        )}
      </div>
      <p className="text-xs text-cos-ink-soft mb-3">
        Aplicaciones satélite con acceso vigente a tu cuenta mediante token de API.
        Al revocar un acceso, la aplicación deberá iniciar sesión de nuevo.
      </p>

      {error && <p className="text-xs text-cos-red-ink mb-2">{error}</p>}

      {tokens === null ? (
        <p className="text-xs text-cos-ink-soft flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando…
        </p>
      ) : tokens.length === 0 ? (
        <p className="text-xs text-cos-ink-soft">No hay accesos de API activos.</p>
      ) : (
        <ul className="divide-y divide-cos-line">
          {tokens.map((t) => (
            <li key={t.id} className="py-2.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{t.etiqueta}</p>
                <p className="text-xs text-cos-ink-soft">
                  Creado: {fechaCorta(t.createdAt)} · Último uso: {fechaCorta(t.lastUsedAt)}
                  {t.ip ? ` · IP ${t.ip}` : ""}
                  {t.scope ? ` · Alcance: ${t.scope}` : ""}
                </p>
              </div>
              <button
                onClick={() => revocar({ id: t.id })}
                disabled={ocupadoId !== null}
                className="shrink-0 text-xs text-cos-red-ink border border-cos-red-ink/40 px-2.5 py-1 rounded-md hover:bg-cos-red-tint disabled:opacity-50"
              >
                {ocupadoId === t.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  "Revocar"
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
