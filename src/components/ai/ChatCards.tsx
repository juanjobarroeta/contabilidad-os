"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Las tarjetas del copiloto: lo que se lee de un vistazo bajo la respuesta.
// El contrato (tipos y saneado) vive en lib/copiloto/tarjetas.ts; aquí sólo
// se pinta. Ningún botón de aquí escribe datos: «turno» manda un mensaje (y si
// hay que cambiar algo, el chat lo propone y se confirma con el tap) y
// «navegar» es un router.push.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight, Bookmark, Check, Copy, FileText, Mail, Pin, X, Zap,
} from "lucide-react";
import type { Accion, Card, Fila, IconoAccion, RefCopiloto, Tono } from "@/lib/copiloto/tarjetas";
import { pasosHechos } from "./useChat";
import { cn } from "@/lib/utils";

const CHIP: Record<Tono, string> = {
  jade: "bg-cos-jade-tint text-cos-jade-ink",
  amber: "bg-cos-amber-tint text-cos-amber-ink",
  red: "bg-cos-red-tint text-cos-red-ink",
  slate: "bg-cos-slate-tint text-cos-ink-soft",
};
const PUNTO: Record<Tono, string> = {
  jade: "bg-cos-jade",
  amber: "bg-cos-amber",
  red: "bg-cos-red",
  slate: "bg-cos-ink-faint",
};

const BASE = "min-w-[260px] rounded-[13px] border border-cos-line bg-cos-card px-[13px] py-3";

function Estatus({ tono, children }: { tono: Tono; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold", CHIP[tono])}>
      <i className={cn("h-1.5 w-1.5 rounded-full", PUNTO[tono])} />
      {children}
    </span>
  );
}

function Filas({ filas, className }: { filas?: Fila[]; className?: string }) {
  if (!filas?.length) return null;
  return (
    <div className={cn("mt-[9px] grid gap-[5px] border-t border-cos-line-soft pt-[9px]", className)}>
      {filas.map(([k, v], i) => (
        <div key={i} className="flex justify-between gap-3 text-[12.5px] text-cos-ink-soft">
          <span>{k}</span>
          <b className="text-right font-mono text-[12px] font-semibold text-cos-ink">{v}</b>
        </div>
      ))}
    </div>
  );
}

function Pasos({ items, inicios }: { items: string[]; inicios: number | null | undefined }) {
  const hechos = pasosHechos(items.length, inicios);
  const enVivo = inicios != null;
  return (
    <ul className={cn(BASE, "grid gap-0.5")}>
      {items.map((t, i) => {
        const ok = i < hechos;
        const corre = enVivo && i === hechos;
        return (
          <li
            key={i}
            className={cn(
              "flex items-center gap-[9px] py-1 text-[12.5px]",
              ok ? "text-cos-ink-soft" : corre ? "text-cos-ink" : "text-cos-ink-faint",
            )}
          >
            <span
              className={cn(
                "grid h-4 w-4 flex-none place-items-center rounded-full border-2",
                ok && "border-cos-jade bg-cos-jade text-white",
                corre && "animate-spin border-cos-brand border-t-transparent motion-reduce:animate-none",
                !ok && !corre && "border-cos-line",
              )}
            >
              {ok && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
            </span>
            {t}
          </li>
        );
      })}
    </ul>
  );
}

function Borrador({ card }: { card: Extract<Card, { type: "borrador" }> }) {
  const [copiado, setCopiado] = useState(false);
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(`Asunto: ${card.asunto}\n\n${card.cuerpo}`);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1600);
    } catch {
      /* sin permiso de portapapeles: el texto sigue a la vista */
    }
  };
  // El envío no sale del chat: no hay buzón conectado. «Abrir en correo» deja
  // el borrador listo en el cliente del usuario, que es quien lo manda.
  const mailto = `mailto:${card.para.includes("@") ? encodeURIComponent(card.para) : ""}?subject=${encodeURIComponent(card.asunto)}&body=${encodeURIComponent(card.cuerpo)}`;
  return (
    <div className={BASE}>
      {card.para && (
        <div className="py-px text-[12px] text-cos-ink-faint">
          Para <b className="ml-1 font-semibold text-cos-ink">{card.para}</b>
        </div>
      )}
      <div className="py-px text-[12px] text-cos-ink-faint">
        Asunto <b className="ml-1 font-semibold text-cos-ink">{card.asunto}</b>
      </div>
      <div className="mt-2 whitespace-pre-wrap border-t border-cos-line-soft pt-2 text-[12.5px] leading-normal text-cos-ink-soft">
        {card.cuerpo}
      </div>
      <div className="mt-2.5 flex gap-1.5">
        <a href={mailto} className={cn(BOTON, BOTON_PRIMARIO)}>
          <Mail className="h-3.5 w-3.5" /> Abrir en correo
        </a>
        <button type="button" onClick={copiar} className={BOTON}>
          {copiado ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copiado ? "Copiado" : "Copiar"}
        </button>
      </div>
    </div>
  );
}

/** Una tarjeta. `inicios` sólo importa para «pasos» (avance en vivo). */
export function ChatCard({ card, inicios }: { card: Card; inicios?: number | null }) {
  switch (card.type) {
    case "obligacion":
      return (
        <div className={BASE}>
          <div className="flex items-center justify-between gap-2.5">
            <span className="text-[13.5px] font-semibold text-cos-ink">{card.titulo}</span>
            <Estatus tono={card.tono}>{card.estatus}</Estatus>
          </div>
          <Filas filas={card.filas} />
        </div>
      );
    case "cifra":
      return (
        <div className={BASE}>
          <div className="text-[11.5px] font-medium text-cos-ink-faint">{card.etiqueta}</div>
          <div className="mt-0.5 text-[24px] font-semibold tabular-nums tracking-[-.02em] text-cos-ink">{card.valor}</div>
          <Filas filas={card.filas} />
          {card.nota && <p className="mt-2 text-[12px] leading-[1.45] text-cos-ink-soft">{card.nota}</p>}
        </div>
      );
    case "lista":
      return (
        <div className={BASE}>
          {card.items.map((it, i) => (
            <div key={i} className="flex items-center gap-2.5 border-t border-cos-line-soft py-[9px] first:border-t-0 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-cos-ink">{it.titulo}</div>
                {it.sub && <div className="mt-px text-[11.5px] text-cos-ink-faint">{it.sub}</div>}
              </div>
              <span className="ml-auto">
                <Estatus tono={it.tono}>{it.estatus}</Estatus>
              </span>
            </div>
          ))}
        </div>
      );
    case "pasos":
      return <Pasos items={card.items} inicios={inicios} />;
    case "hecho":
      return (
        <div className={cn(BASE, "border-cos-jade/30 bg-cos-jade-tint")}>
          <div className="flex items-center gap-[7px] text-[13.5px] font-semibold text-cos-jade-ink">
            <Check className="h-[15px] w-[15px]" /> {card.titulo}
          </div>
          <Filas filas={card.filas} className="border-cos-jade/30 [&_b]:text-cos-jade-ink [&_div]:text-cos-jade-ink" />
        </div>
      );
    case "borrador":
      return <Borrador card={card} />;
    case "retomar":
      return (
        <div className={cn(BASE, "border-transparent bg-cos-brand-tint")}>
          <div className="flex items-center gap-[5px] text-[11.5px] font-medium text-cos-brand-ink">
            <Bookmark className="h-3 w-3" /> De la última vez{card.cuando ? ` · ${card.cuando}` : ""}
          </div>
          <div className="mt-1 text-[13.5px] font-semibold text-cos-brand-ink">{card.titulo}</div>
          {card.nota && <p className="mt-2 text-[12px] leading-[1.45] text-cos-ink-soft">{card.nota}</p>}
        </div>
      );
    case "memoria":
      return (
        <div className="-mt-1 flex items-center gap-1.5 self-start text-[11.5px] text-cos-brand-ink">
          <Bookmark className="h-3 w-3 flex-none" /> Guardado en memoria: {card.texto}
        </div>
      );
    case "acciones":
      return null; // las pinta <AccionesChat>, que lleva el estado del tap
  }
}

// ── Botones de acción ────────────────────────────────────────────────────────

const BOTON =
  "inline-flex items-center gap-1.5 rounded-[9px] border border-cos-line bg-cos-card px-[11px] py-[7px] text-[12.5px] font-semibold text-cos-ink transition-colors hover:bg-cos-paper";
const BOTON_PRIMARIO = "border-cos-brand bg-cos-brand text-white hover:bg-cos-brand-deep";

const ICONO: Record<IconoAccion, React.ComponentType<{ className?: string }>> = {
  zap: Zap,
  arrow: ArrowRight,
  mail: Mail,
  file: FileText,
  check: Check,
};

/**
 * Un grupo de botones. Al tocar uno que manda turno, el resto se apaga (40%,
 * inerte) y el elegido queda visible: la conversación ya siguió por ahí. Los de
 * navegación no consumen el grupo — ir a ver algo no es decidir.
 */
export function AccionesChat({
  acciones,
  onTurno,
  deshabilitado,
}: {
  acciones: Accion[];
  onTurno: (seed: string) => void;
  deshabilitado?: boolean;
}) {
  const router = useRouter();
  const [elegida, setElegida] = useState<number | null>(null);
  return (
    <div className="flex flex-wrap gap-1.5">
      {acciones.map((a, i) => {
        const Icono = a.icon ? ICONO[a.icon] : null;
        const apagado = a.kind === "turno" && elegida !== null && elegida !== i;
        return (
          <button
            key={i}
            type="button"
            disabled={a.kind === "turno" && (elegida !== null || deshabilitado)}
            onClick={() => {
              if (a.kind === "navegar" && a.href) {
                router.push(a.href);
                return;
              }
              if (a.seed) {
                setElegida(i);
                onTurno(a.seed);
              }
            }}
            className={cn(
              BOTON,
              a.primary && BOTON_PRIMARIO,
              apagado && "pointer-events-none opacity-40",
              elegida === i && "opacity-100",
              "disabled:cursor-default",
            )}
          >
            {Icono && <Icono className="h-3.5 w-3.5" />}
            {a.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Píldora de referencia ────────────────────────────────────────────────────

export function PildoraRef({ refC, origen, onQuitar }: { refC: RefCopiloto; origen?: string; onQuitar?: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-cos-brand-tint px-[9px] py-[5px] text-[12px] font-semibold text-cos-brand-ink">
      <Pin className="h-[13px] w-[13px] flex-none" />
      <span className="truncate">{refC.titulo}</span>
      {origen && <span className="flex-none font-normal opacity-80">· {origen}</span>}
      {onQuitar && (
        <button type="button" onClick={onQuitar} title="Quitar" className="ml-0.5 grid flex-none place-items-center">
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
