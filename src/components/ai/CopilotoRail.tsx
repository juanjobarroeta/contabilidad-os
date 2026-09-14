"use client";

// ─────────────────────────────────────────────────────────────────────────────
// COPILOTO v3 — TRABAJO, NO PROBLEMAS.
//
// El rail v2 agrupaba hallazgos en cartas-verbo, y aun así nadie lo abría: por
// bien agrupada que esté, una lista de problemas sigue siendo una lista de
// problemas. «13,778 posibles duplicados» no es información, es un número que
// paraliza — y encima suele significar que el check está marcando un patrón
// normal del negocio, no que haya 13,778 errores.
//
// Tres bloques, y el orden es el argumento:
//
//   1. LO QUE HICE      — un asistente que no puede enseñar su trabajo no se
//                         distingue de uno que no hizo nada.
//   2. LO QUE NECESITO  — lo único que el despacho NO puede resolver solo. Va
//                         antes que el diagnóstico porque es lo accionable.
//   3. CÓMO VAMOS       — el estado, al final: es contexto, no tarea.
//
// Todo el criterio vive en `lib/rail/armar.ts`, que es puro y está probado.
// Aquí sólo se pinta.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight, Check, ChevronLeft, ChevronRight, Inbox, MessageCircle, Search, Sparkles,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Alert, RetryButton } from "@/components/ui/feedback";
import { Skeleton } from "@/components/ui/Skeleton";
import { esperaEnTexto, type Rail } from "@/lib/rail/armar";
import type { EstadoSalud } from "@/lib/salud/claves";
import { cn } from "@/lib/utils";

interface RailRespuesta extends Rail {
  resumen: { titulo: string; cuerpo: string; fecha: string } | null;
  informativos: number;
}

const PUNTO: Record<EstadoSalud, string> = {
  bloquea: "bg-cos-red",
  atencion: "bg-cos-amber",
  ok: "bg-cos-jade",
  sin_datos: "bg-cos-ink-faint",
};

const TITULO_BLOQUE = "px-1 text-[11px] font-semibold uppercase tracking-[.08em] text-cos-ink-faint";

function cuandoPaso(iso: string | null): string {
  if (!iso) return "Todavía no ha pasado por esta empresa.";
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (dias <= 0) return "Revisada hoy";
  if (dias === 1) return "Revisada ayer";
  return `Revisada hace ${dias} días`;
}

export function CopilotoRail() {
  const { activeCompany } = useCompany();
  const [colapsado, setColapsado] = useState(false);
  const [rail, setRail] = useState<RailRespuesta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const companyId = activeCompany?.id;

  const cargar = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/rail?companyId=${companyId}`);
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
      setRail(j as RailRespuesta);
    } catch {
      setRail(null);
      setError("No se pudo cargar el copiloto.");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (!companyId) return null;

  const pendientes = rail?.necesito.length ?? 0;

  if (colapsado) {
    return (
      <aside className="hidden xl:flex w-12 flex-none flex-col items-center gap-3 border-l border-cos-line bg-cos-card py-4 print:hidden">
        <button
          type="button"
          onClick={() => setColapsado(false)}
          title="Abrir copiloto"
          className="rounded-control p-1.5 text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="relative">
          <Sparkles className="h-5 w-5 text-cos-brand" />
          {/* El globo cuenta lo que necesita de TI, no los problemas que hay.
              Un número que el usuario no puede bajar sólo enseña a ignorarlo. */}
          {pendientes > 0 && (
            <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-cos-amber px-1 text-[10px] font-bold text-white">
              {pendientes}
            </span>
          )}
        </div>
      </aside>
    );
  }

  return (
    <aside className="hidden xl:flex w-[300px] flex-none flex-col border-l border-cos-line bg-cos-card print:hidden">
      <div className="flex items-center justify-between border-b border-cos-line px-4 py-3">
        <span className="inline-flex items-center gap-2 text-[13.5px] font-semibold text-cos-ink">
          <Sparkles className="h-4 w-4 text-cos-brand" /> Copiloto
        </span>
        <button
          type="button"
          onClick={() => setColapsado(true)}
          title="Colapsar"
          className="rounded-control p-1 text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {error && (
          <Alert tone="danger" action={<RetryButton onClick={cargar} />}>
            {error}
          </Alert>
        )}
        {loading && !error && (
          <>
            <Skeleton className="h-20 rounded-card" />
            <Skeleton className="h-24 rounded-card" />
          </>
        )}

        {!loading && !error && rail && (
          <>
            {/* ── 1. Lo que hice ──────────────────────────────────────────── */}
            <section className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <p className={TITULO_BLOQUE}>Lo que hice</p>
                <span className="text-[11px] text-cos-ink-faint">{cuandoPaso(rail.ultimaPasada)}</span>
              </div>
              {rail.hice.length === 0 ? (
                <p className="rounded-card border border-cos-line-soft bg-cos-paper px-3 py-2 text-[12.5px] text-cos-ink-faint">
                  {rail.ultimaPasada
                    ? "En la última revisión no hubo nada que resolver por mi cuenta."
                    : "Todavía no he hecho una revisión de esta empresa."}
                </p>
              ) : (
                <ul className="space-y-1">
                  {rail.hice.map((h, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-1.5 rounded-card border border-cos-jade-ink/15 bg-cos-jade-tint px-2.5 py-1.5 text-[12.5px] text-cos-jade-ink"
                    >
                      <Check className="mt-0.5 h-3.5 w-3.5 flex-none" />
                      <span>{h.texto}</span>
                    </li>
                  ))}
                </ul>
              )}
              {rail.resumen && (
                <Link
                  href="/expediente"
                  className="block px-1 text-[11.5px] font-medium text-cos-brand-ink hover:underline"
                >
                  Ver la revisión completa →
                </Link>
              )}
            </section>

            {/* ── 2. Lo que necesito de ti ────────────────────────────────── */}
            <section className="space-y-1.5">
              <p className={TITULO_BLOQUE}>Lo que necesito de ti</p>
              {rail.necesito.length === 0 ? (
                <p className="rounded-card border border-cos-line-soft bg-cos-paper px-3 py-2 text-[12.5px] text-cos-ink-faint">
                  Nada por ahora. Cuando necesite algo tuyo, aparece aquí.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {rail.necesito.map((p) => {
                    const cuerpo = (
                      <>
                        <div className="flex items-start gap-1.5">
                          <Inbox className="mt-0.5 h-3.5 w-3.5 flex-none text-cos-amber-ink" />
                          <p className="text-[12.5px] font-semibold leading-snug text-cos-ink">{p.titulo}</p>
                        </div>
                        <p className="mt-0.5 line-clamp-2 pl-5 text-[11.5px] text-cos-ink-soft">{p.detalle}</p>
                        {p.dias > 0 && (
                          <p
                            className={cn(
                              "mt-0.5 pl-5 text-[11px]",
                              p.dias >= 21 ? "font-semibold text-cos-red-ink" : "text-cos-ink-faint",
                            )}
                          >
                            {esperaEnTexto(p.dias)}
                          </p>
                        )}
                      </>
                    );
                    const clase =
                      "block rounded-card border border-cos-amber-tint bg-cos-paper px-2.5 py-2 transition-colors hover:border-cos-brand/40";
                    return (
                      <li key={p.id}>
                        {p.href ? (
                          <Link href={p.href} className={clase}>
                            {cuerpo}
                            <span className="mt-1 inline-flex items-center gap-1 pl-5 text-[11.5px] font-semibold text-cos-brand-ink">
                              Resolver <ArrowRight className="h-3 w-3" />
                            </span>
                          </Link>
                        ) : (
                          <div className={clase}>{cuerpo}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* ── Revisiones: lo que NO cabe como lista ───────────────────── */}
            {rail.revisiones.length > 0 && (
              <section className="space-y-1.5">
                <p className={TITULO_BLOQUE}>Para revisar en bloque</p>
                {rail.revisiones.map((r) => (
                  <div key={r.href} className="rounded-card border border-cos-line bg-cos-paper px-2.5 py-2">
                    <div className="flex items-start gap-1.5">
                      <Search className="mt-0.5 h-3.5 w-3.5 flex-none text-cos-ink-faint" />
                      <p className="text-[12.5px] font-semibold leading-snug text-cos-ink">{r.titulo}</p>
                    </div>
                    <p className="mt-0.5 pl-5 text-[11.5px] text-cos-ink-soft">{r.triage}</p>
                    {r.muestra.length > 0 && (
                      <p className="mt-0.5 line-clamp-1 pl-5 text-[11px] text-cos-ink-faint">
                        p. ej. {r.muestra[0]}
                      </p>
                    )}
                    <Link
                      href={r.href}
                      className="mt-1 inline-flex items-center gap-1 pl-5 text-[11.5px] font-semibold text-cos-brand-ink hover:underline"
                    >
                      Ver una muestra <ArrowRight className="h-3 w-3" />
                    </Link>
                  </div>
                ))}
              </section>
            )}

            {/* ── 3. Cómo vamos ──────────────────────────────────────────── */}
            {rail.vamos.length > 0 && (
              <section className="space-y-1">
                <p className={TITULO_BLOQUE}>Cómo vamos</p>
                <ul className="rounded-card border border-cos-line-soft bg-cos-paper">
                  {rail.vamos.map((d) => (
                    <li
                      key={d.clave}
                      className="flex items-center gap-2 border-b border-cos-line-soft px-2.5 py-1.5 last:border-b-0"
                      title={d.detalle}
                    >
                      <span className={cn("h-1.5 w-1.5 flex-none rounded-full", PUNTO[d.estado])} />
                      <span className="flex-1 truncate text-[12px] text-cos-ink-soft">{d.titulo}</span>
                      {d.cambio && (
                        <span className="text-[10.5px] font-medium text-cos-amber-ink">{d.cambio}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>

      <div className="border-t border-cos-line p-3">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("cos:ask-ai"))}
          className="flex w-full items-center justify-center gap-2 rounded-control bg-cos-brand px-3 py-2 text-[13px] font-medium text-white hover:bg-cos-brand-deep"
        >
          <MessageCircle className="h-3.5 w-3.5" /> Preguntar al copiloto
        </button>
      </div>
    </aside>
  );
}
