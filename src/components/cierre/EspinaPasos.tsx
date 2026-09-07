"use client";

// ─────────────────────────────────────────────────────────────────────────────
// La espina del cierre: los doce pasos como mapa, no como pantalla. Densa a
// propósito — el detalle lo cuenta el copiloto en la conversación; aquí sólo se
// ve dónde estás, qué falta y qué ya confirmaste.
// ─────────────────────────────────────────────────────────────────────────────

import { Check, Lock, Minus, TriangleAlert, RotateCcw, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PasoConDecision } from "@/lib/cierre/evaluar";
import type { ClavePasoCierre } from "@/lib/cierre/claves";

const PINTA: Record<PasoConDecision["estadoCalculado"], { Icon: typeof Check; clase: string }> = {
  listo: { Icon: Check, clase: "bg-cos-jade-tint text-cos-jade-ink" },
  atencion: { Icon: TriangleAlert, clase: "bg-cos-amber-tint text-cos-amber-ink" },
  bloquea: { Icon: TriangleAlert, clase: "bg-cos-red-tint text-cos-red-ink" },
  espera: { Icon: Lock, clase: "bg-cos-slate-tint text-cos-ink-faint" },
  no_aplica: { Icon: Minus, clase: "bg-cos-slate-tint text-cos-ink-faint" },
  sin_datos: { Icon: Minus, clase: "bg-cos-slate-tint text-cos-ink-faint" },
};

/** Cuando el humano ya decidió, el icono lo dice a él, no al motor. */
const DECIDIDO = {
  confirmado: { Icon: Check, clase: "bg-cos-jade-tint text-cos-jade-ink" },
  omitido: { Icon: Ban, clase: "bg-cos-slate-tint text-cos-ink-faint" },
  revisar: { Icon: RotateCcw, clase: "bg-cos-amber-tint text-cos-amber-ink" },
} as const;

export function EspinaPasos({
  pasos,
  activo,
  onSelect,
}: {
  pasos: PasoConDecision[];
  activo: ClavePasoCierre | null;
  onSelect: (clave: ClavePasoCierre) => void;
}) {
  return (
    <ol className="space-y-0.5">
      {pasos.map((p, i) => {
        const confirmado = p.estado === "CONFIRMADO";
        const omitido = p.estado === "OMITIDO";
        const revisar = p.estado === "REVISAR";
        // LA DECISIÓN HUMANA GANA EL ICONO. Antes el badge pintaba siempre el
        // estado del motor y la palomita de «lo revisé» iba aparte: un paso
        // confirmado con observaciones salía en amarillo Y con palomita, que se
        // lee como una contradicción. Ahora dice quién manda; lo que el motor
        // sigue marcando se cuenta en el tooltip, no con un segundo color.
        const pinta = confirmado
          ? DECIDIDO.confirmado
          : omitido
            ? DECIDIDO.omitido
            : revisar
              ? DECIDIDO.revisar
              : PINTA[p.estadoCalculado];
        const esActivo = p.clave === activo;
        const observacion =
          (confirmado || omitido) && p.estadoCalculado !== "listo" && p.estadoCalculado !== "no_aplica"
            ? `Lo diste por revisado. El motor todavía marca: ${p.detalle ?? p.estadoCalculado}`
            : null;
        return (
          <li key={p.clave}>
            <button
              type="button"
              onClick={() => onSelect(p.clave)}
              title={observacion ?? p.detalle ?? p.titulo}
              className={cn(
                "flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors",
                esActivo ? "bg-cos-brand-tint" : "hover:bg-cos-paper",
                p.estadoCalculado === "no_aplica" && "opacity-45"
              )}
            >
              <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full", pinta.clase)}>
                <pinta.Icon className="h-3 w-3" />
              </span>
              <span className="font-mono text-[10px] text-cos-ink-faint">{String(i + 1).padStart(2, "0")}</span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[12.5px]",
                  esActivo ? "font-semibold text-cos-ink" : "text-cos-ink-soft"
                )}
              >
                {p.titulo}
              </span>
              {observacion && <span className="shrink-0 text-[10px] text-cos-amber-ink">con observaciones</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
