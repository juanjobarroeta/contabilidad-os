import * as React from "react";
import { cn } from "@/lib/utils";

// Status vocabulary rendered identically everywhere (Inicio, Impuestos, Bancos).
export type ChipStatus =
  | "aldia"
  | "presentada"
  | "conciliado"
  | "pendiente"
  | "porvencer"
  | "sin_conciliar"
  | "vencida"
  | "atrasada";

type ChipTone = "jade" | "amber" | "red" | "slate";

const STATUS: Record<ChipStatus, { t: string; c: ChipTone }> = {
  aldia: { t: "Al día", c: "jade" },
  presentada: { t: "Presentada", c: "jade" },
  conciliado: { t: "Conciliado", c: "jade" },
  pendiente: { t: "Pendiente", c: "slate" },
  porvencer: { t: "Por vencer", c: "amber" },
  sin_conciliar: { t: "Sin conciliar", c: "amber" },
  vencida: { t: "Vencida", c: "red" },
  atrasada: { t: "Atrasada", c: "red" },
};

const TONE: Record<ChipTone, string> = {
  jade: "bg-cos-jade-tint text-cos-jade-ink",
  amber: "bg-cos-amber-tint text-cos-amber-ink",
  red: "bg-cos-red-tint text-cos-red-ink",
  slate: "bg-cos-slate-tint text-cos-ink-soft",
};

export interface ChipProps {
  /** Known status → fixed label + tone. */
  status?: ChipStatus;
  /** Override the tone directly (when not using a status). */
  tone?: ChipTone;
  /** Override the label (defaults to the status' Spanish label). */
  label?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}

/** Pill status chip — the semantic counterpart of Badge in the Contia palette. */
export function Chip({ status, tone, label, icon, className }: ChipProps) {
  const s = status ? STATUS[status] : null;
  const c = tone ?? s?.c ?? "slate";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12.5px] font-semibold whitespace-nowrap",
        TONE[c],
        className
      )}
    >
      {icon}
      {label ?? s?.t ?? status}
    </span>
  );
}
