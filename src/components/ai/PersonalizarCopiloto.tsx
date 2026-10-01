"use client";

import { IDS_PERSONAJE, MAX_NOMBRE, PERSONAJES, colorDe, indiceColor, nombreDe, type Piel } from "@/lib/copiloto/personajes";
import { PetSkin } from "./PetSkin";
import { cn } from "@/lib/utils";

// «Personalizar»: personaje, color y nombre. Sólo cambia cómo se ve; la
// memoria y las respuestas son las mismas.

const ETIQUETA = "px-1 pb-2 pt-3.5 font-mono text-[10px] font-semibold uppercase tracking-[.12em] text-cos-ink-faint";

export function PersonalizarCopiloto({ piel, onCambio }: { piel: Piel; onCambio: (p: Piel) => void }) {
  const actual = PERSONAJES[piel.char];
  return (
    <div className="flex-1 overflow-y-auto overscroll-contain px-3 pb-4 pt-1">
      <p className={ETIQUETA}>Personaje</p>
      <div className="grid grid-cols-3 gap-2">
        {IDS_PERSONAJE.map((id) => {
          const p = PERSONAJES[id];
          const on = id === piel.char;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              onClick={() => onCambio({ ...piel, char: id })}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-[14px] border-[1.5px] px-1.5 pb-3 pt-[22px] text-center transition-colors hover:border-cos-brand",
                on ? "border-cos-brand bg-cos-brand-tint" : "border-cos-line bg-cos-card",
              )}
            >
              <span className="relative mb-1 block h-[58px] w-[58px]">
                <PetSkin char={id} color={colorDe(piel, id)} />
              </span>
              <b className="text-[13px] font-semibold text-cos-ink">{on ? nombreDe(piel) : p.label}</b>
              <small className="text-[11px] leading-[1.3] text-cos-ink-faint">{p.desc}</small>
            </button>
          );
        })}
      </div>

      <p className={ETIQUETA}>Color</p>
      <div className="flex flex-wrap gap-1.5">
        {actual.colores.map(([nombre, valor], i) => {
          const on = i === indiceColor(piel);
          return (
            <button
              key={nombre}
              type="button"
              aria-pressed={on}
              onClick={() => onCambio({ ...piel, colors: { ...piel.colors, [piel.char]: i } })}
              className={cn(
                "flex w-[72px] flex-col items-center gap-1.5 text-[11.5px]",
                on ? "font-semibold text-cos-ink" : "text-cos-ink-soft",
              )}
            >
              <i
                className={cn(
                  "h-[34px] w-[34px] rounded-full border border-black/10 transition-shadow",
                  on && "shadow-[0_0_0_2.5px_var(--card),0_0_0_4.5px_var(--brand)]",
                )}
                style={{ background: valor }}
              />
              {nombre}
            </button>
          );
        })}
      </div>

      <p className={ETIQUETA}>Nombre</p>
      <input
        value={piel.name ?? ""}
        maxLength={MAX_NOMBRE}
        placeholder={actual.label}
        onChange={(e) => onCambio({ ...piel, name: e.target.value.trim() ? e.target.value.slice(0, MAX_NOMBRE) : null })}
        className="w-full rounded-[10px] border border-cos-line bg-cos-canvas px-3 py-2.5 text-[13.5px] text-cos-ink outline-none focus:border-cos-brand"
      />
      <p className="mt-3.5 px-0.5 text-[12px] leading-[1.45] text-cos-ink-faint">
        Sólo cambia cómo se ve. Recuerda lo mismo y responde igual.
      </p>
    </div>
  );
}
