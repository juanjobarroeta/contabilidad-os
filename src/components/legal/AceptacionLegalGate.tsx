"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ScrollText } from "lucide-react";

/**
 * Pantalla bloqueante de aceptación de documentos legales.
 *
 * El layout de la app calcula en servidor qué documentos de cuenta (Términos,
 * Aviso) le faltan al usuario en su versión vigente y, si hay alguno, monta
 * este componente encima de la app. No se puede cerrar: la única salida es
 * aceptar (POST /api/legal/aceptar) — o cerrar sesión desde el navegador.
 *
 * Casos que llegan aquí:
 *   - Cambió la versión de un documento (src/lib/legal/documentos.ts).
 *   - La cuenta se creó sin pasar por el signup (alta por un administrador o
 *     desde un satélite), así que nunca aceptó nada.
 *   - Cuentas anteriores a la introducción del registro de aceptaciones.
 */
export type DocumentoPendiente = { documento: string; titulo: string; url: string; version: string };

export function AceptacionLegalGate({ pendientes }: { pendientes: DocumentoPendiente[] }) {
  const router = useRouter();
  const [acepta, setAcepta] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState("");

  if (pendientes.length === 0) return null;

  async function aceptar() {
    setEnviando(true);
    setError("");
    try {
      const res = await fetch("/api/legal/aceptar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acepta }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "No se pudo registrar la aceptación");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
      setEnviando(false);
    }
  }

  const lista = pendientes.map((d) => d.titulo).join(" y ");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="aceptacion-legal-titulo"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-cos-ink/60 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-cos-line bg-cos-card p-6 shadow-xl">
        <div className="mb-3 flex items-center gap-2 text-cos-brand-ink">
          <ScrollText className="h-5 w-5" />
          <h2 id="aceptacion-legal-titulo" className="text-base font-semibold text-cos-ink">
            Actualizamos nuestros documentos legales
          </h2>
        </div>
        <p className="text-sm leading-relaxed text-cos-ink-soft">
          Para seguir usando ContabilidadOS necesitamos que leas y aceptes {lista}.
        </p>
        <ul className="mt-3 space-y-1.5 text-sm">
          {pendientes.map((d) => (
            <li key={d.documento}>
              <a
                href={d.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-cos-brand-ink hover:underline"
              >
                {d.titulo}
              </a>
              <span className="ml-2 text-xs text-cos-ink-faint">versión {d.version}</span>
            </li>
          ))}
        </ul>
        <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-cos-line px-3 py-2.5">
          <input
            type="checkbox"
            checked={acepta}
            onChange={(e) => setAcepta(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-cos-brand"
          />
          <span className="text-[13px] leading-relaxed text-cos-ink-soft">
            He leído y acepto {lista}.
          </span>
        </label>
        {error && (
          <p className="mt-3 rounded-lg border border-cos-red-ink/20 bg-cos-red-tint px-3 py-2 text-[13px] text-cos-red-ink">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={aceptar}
          disabled={!acepta || enviando}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-cos-brand py-2.5 text-sm font-semibold text-white transition-colors hover:bg-cos-brand-deep disabled:opacity-50"
        >
          {enviando && <Loader2 className="h-4 w-4 animate-spin" />}
          {enviando ? "Guardando…" : "Aceptar y continuar"}
        </button>
      </div>
    </div>
  );
}
