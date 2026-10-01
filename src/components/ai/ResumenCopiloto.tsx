"use client";

// ─────────────────────────────────────────────────────────────────────────────
// «RESUMEN» — lo que antes vivía en el rail lateral, ahora dentro del chat.
//
// El orden es el argumento (ver lib/rail/armar.ts, que decide todo):
//   1. LO QUE HICE      — un asistente que no enseña su trabajo no se
//                         distingue de uno que no hizo nada.
//   2. LO QUE NECESITO  — lo único que el despacho no puede resolver solo.
//   3. CÓMO VAMOS       — el estado, al final: es contexto, no tarea.
// Aquí sólo se pinta.
// ─────────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { ArrowRight, Check, Inbox, MessageCircle, Search } from "lucide-react";
import { Alert, RetryButton } from "@/components/ui/feedback";
import { Skeleton } from "@/components/ui/Skeleton";
import { esperaEnTexto } from "@/lib/rail/armar";
import type { EstadoSalud } from "@/lib/salud/claves";
import type { RailRespuesta } from "./useRailCopiloto";
import { cn } from "@/lib/utils";

const PUNTO: Record<EstadoSalud, string> = {
  bloquea: "bg-cos-red",
  atencion: "bg-cos-amber",
  ok: "bg-cos-jade",
  sin_datos: "bg-cos-ink-faint",
};

const ETIQUETA = "px-1 pb-2 pt-3.5 font-mono text-[10px] font-semibold uppercase tracking-[.12em] text-cos-ink-faint";

function cuandoPaso(iso: string | null): string {
  if (!iso) return "Todavía no ha pasado por esta empresa.";
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (dias <= 0) return "Revisada hoy";
  if (dias === 1) return "Revisada ayer";
  return `Revisada hace ${dias} días`;
}

export function ResumenCopiloto({
  rail,
  cargando,
  error,
  recargar,
  onPreguntar,
  onNavegar,
}: {
  rail: RailRespuesta | null;
  cargando: boolean;
  error: string | null;
  recargar: () => void;
  /** Manda el pedido como turno al chat. */
  onPreguntar: (seed: string) => void;
  /** Al seguir un enlace (en móvil se cierra el cajón). */
  onNavegar?: () => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto overscroll-contain px-3 pb-4 pt-1">
      {error && (
        <div className="pt-3">
          <Alert tone="danger" action={<RetryButton onClick={recargar} />}>
            {error}
          </Alert>
        </div>
      )}
      {cargando && !rail && !error && (
        <div className="space-y-2 pt-3">
          <Skeleton className="h-20 rounded-card" />
          <Skeleton className="h-24 rounded-card" />
        </div>
      )}

      {rail && (
        <>
          {/* ── 1. Lo que hice ─────────────────────────────────────────── */}
          <div className="flex items-baseline justify-between">
            <p className={ETIQUETA}>Lo que hice</p>
            <span className="text-[11px] text-cos-ink-faint">{cuandoPaso(rail.ultimaPasada)}</span>
          </div>
          {rail.hice.length === 0 ? (
            <p className="rounded-[10px] bg-cos-paper px-[11px] py-2.5 text-[12.5px] text-cos-ink-faint">
              {rail.ultimaPasada
                ? "En la última revisión no hubo nada que resolver por mi cuenta."
                : "Todavía no he hecho una revisión de esta empresa."}
            </p>
          ) : (
            <ul className="space-y-1">
              {rail.hice.map((h, i) => (
                <li
                  key={i}
                  className="flex items-start gap-1.5 rounded-[10px] border border-cos-jade/20 bg-cos-jade-tint px-[11px] py-2 text-[12.5px] text-cos-jade-ink"
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
              onClick={onNavegar}
              className="mt-1.5 block px-1 text-[11.5px] font-medium text-cos-brand-ink hover:underline"
            >
              Ver la revisión completa →
            </Link>
          )}

          {/* ── 2. Lo que necesito de ti ───────────────────────────────── */}
          <p className={ETIQUETA}>Lo que necesito de ti</p>
          {rail.necesito.length === 0 ? (
            <p className="rounded-[10px] bg-cos-paper px-[11px] py-2.5 text-[12.5px] text-cos-ink-faint">
              Nada por ahora. Cuando necesite algo tuyo, aparece aquí.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {rail.necesito.map((p) => (
                <li key={p.id} className="rounded-[10px] border border-cos-amber-tint bg-cos-paper px-[11px] py-2">
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
                  <div className="mt-1.5 flex gap-3 pl-5">
                    {p.href && (
                      <Link
                        href={p.href}
                        onClick={onNavegar}
                        className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-cos-brand-ink hover:underline"
                      >
                        Resolver <ArrowRight className="h-3 w-3" />
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={() => onPreguntar(`Ayúdame con esto: ${p.titulo}. ${p.detalle}`)}
                      className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-cos-ink-soft hover:text-cos-ink"
                    >
                      <MessageCircle className="h-3 w-3" /> Preguntar
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* ── Revisiones: lo que no cabe como lista ──────────────────── */}
          {rail.revisiones.length > 0 && (
            <>
              <p className={ETIQUETA}>Para revisar en bloque</p>
              <div className="space-y-1.5">
                {rail.revisiones.map((r) => (
                  <div key={r.href} className="rounded-[10px] border border-cos-line bg-cos-paper px-[11px] py-2">
                    <div className="flex items-start gap-1.5">
                      <Search className="mt-0.5 h-3.5 w-3.5 flex-none text-cos-ink-faint" />
                      <p className="text-[12.5px] font-semibold leading-snug text-cos-ink">{r.titulo}</p>
                    </div>
                    <p className="mt-0.5 pl-5 text-[11.5px] text-cos-ink-soft">{r.triage}</p>
                    {r.muestra.length > 0 && (
                      <p className="mt-0.5 line-clamp-1 pl-5 text-[11px] text-cos-ink-faint">p. ej. {r.muestra[0]}</p>
                    )}
                    <Link
                      href={r.href}
                      onClick={onNavegar}
                      className="mt-1 inline-flex items-center gap-1 pl-5 text-[11.5px] font-semibold text-cos-brand-ink hover:underline"
                    >
                      Ver una muestra <ArrowRight className="h-3 w-3" />
                    </Link>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── 3. Cómo vamos ──────────────────────────────────────────── */}
          {rail.vamos.length > 0 && (
            <>
              <p className={ETIQUETA}>Cómo vamos</p>
              <ul className="rounded-[10px] border border-cos-line-soft bg-cos-paper">
                {rail.vamos.map((d) => (
                  <li
                    key={d.clave}
                    className="flex items-center gap-2 border-b border-cos-line-soft px-[11px] py-1.5 last:border-b-0"
                    title={d.detalle}
                  >
                    <span className={cn("h-1.5 w-1.5 flex-none rounded-full", PUNTO[d.estado])} />
                    <span className="flex-1 truncate text-[12px] text-cos-ink-soft">{d.titulo}</span>
                    {d.cambio && <span className="text-[10.5px] font-medium text-cos-amber-ink">{d.cambio}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
