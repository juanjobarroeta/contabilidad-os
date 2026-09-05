"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Columna izquierda del workspace: los doce pasos con su estado y «el número
// que importa». Nunca sólo un ícono. El activo se fija en la URL (?paso=).
// ─────────────────────────────────────────────────────────────────────────────

import { Check, Lock, Minus, TriangleAlert, RotateCcw, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PasoConDecision } from "@/lib/cierre/evaluar";

const PINTA: Record<PasoConDecision["estadoCalculado"], { Icon: typeof Check; clase: string; marca: string }> = {
  listo: { Icon: Check, clase: "bg-cos-jade-tint text-cos-jade-ink", marca: "listo" },
  atencion: { Icon: TriangleAlert, clase: "bg-cos-amber-tint text-cos-amber-ink", marca: "atención" },
  bloquea: { Icon: TriangleAlert, clase: "bg-cos-red-tint text-cos-red-ink", marca: "bloquea" },
  espera: { Icon: Lock, clase: "bg-cos-slate-tint text-cos-ink-faint", marca: "espera" },
  no_aplica: { Icon: Minus, clase: "bg-cos-slate-tint text-cos-ink-faint", marca: "no aplica" },
  sin_datos: { Icon: Minus, clase: "bg-cos-slate-tint text-cos-ink-faint", marca: "sin datos" },
};

export function marcaDecision(p: PasoConDecision): { texto: string; clase: string; Icon: typeof Check } | null {
  if (p.estado === "CONFIRMADO") return { texto: "confirmado", clase: "text-cos-jade-ink", Icon: Check };
  if (p.estado === "OMITIDO") return { texto: "omitido", clase: "text-cos-ink-soft", Icon: Ban };
  if (p.estado === "REVISAR") return { texto: "cambió · revisar", clase: "text-cos-amber-ink", Icon: RotateCcw };
  return null;
}

export function ListaPasos({
  pasos,
  activo,
  onSelect,
}: {
  pasos: PasoConDecision[];
  activo: string | null;
  onSelect: (clave: PasoConDecision["clave"]) => void;
}) {
  return (
    <ol className="space-y-1">
      {pasos.map((p, i) => {
        const pinta = PINTA[p.estadoCalculado];
        const dec = marcaDecision(p);
        const esActivo = p.clave === activo;
        return (
          <li key={p.clave}>
            <button
              type="button"
              onClick={() => onSelect(p.clave)}
              className={cn(
                "flex w-full items-start gap-3 rounded-control border px-3 py-2 text-left transition-colors",
                esActivo ? "border-cos-brand/60 bg-cos-brand-tint" : "border-transparent hover:bg-cos-paper",
                p.estadoCalculado === "no_aplica" && "opacity-50"
              )}
            >
              <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", pinta.clase)}>
                <pinta.Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-cos-ink-faint">{String(i + 1).padStart(2, "0")}</span>
                  <span className="truncate text-[13px] font-semibold text-cos-ink">{p.titulo}</span>
                  {dec && (
                    <span className={cn("ml-auto inline-flex items-center gap-1 font-mono text-[10px] font-semibold", dec.clase)}>
                      <dec.Icon className="h-3 w-3" /> {dec.texto}
                    </span>
                  )}
                </span>
                <span className="block truncate text-[12px] text-cos-ink-soft">{p.detalle ?? pinta.marca}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
