import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Franja de stats al abrir un módulo (idioma del deck People): 3–4 tarjetas
 * con etiqueta mono en mayúsculas y el número grande en mono. La etiqueta
 * dice QUÉ es; el tono del valor dice CÓMO va (ink/jade/amber/red).
 */
export type StatTone = "ink" | "jade" | "amber" | "red" | "brand";

const TONE: Record<StatTone, string> = {
  ink: "text-cos-ink",
  jade: "text-cos-jade-ink",
  amber: "text-cos-amber-ink",
  red: "text-cos-red-ink",
  brand: "text-cos-brand-ink",
};

export function StatTile({
  label,
  value,
  tone = "ink",
  sub,
  className,
}: {
  label: string;
  /** Número o nodo (p. ej. <Money/>); se renderiza grande y en mono. */
  value: React.ReactNode;
  tone?: StatTone;
  /** Nota chica bajo el valor (p. ej. "3 despachos", "76.2 %"). */
  sub?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-card border border-cos-line bg-cos-card px-4 py-3", className)}>
      <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-cos-ink-faint">
        {label}
      </p>
      <p className={cn("mt-1 font-mono text-[20px] font-semibold leading-none tabular-nums", TONE[tone])}>
        {value}
      </p>
      {sub && <p className="mt-1 text-[12px] text-cos-ink-soft">{sub}</p>}
    </div>
  );
}

/** Fila responsiva de StatTiles. */
export function StatStrip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4", className)}>{children}</div>
  );
}
