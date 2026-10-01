"use client";

import type { CSSProperties, Ref } from "react";
import type { IdPersonaje } from "@/lib/copiloto/personajes";
import { cn } from "@/lib/utils";

// Las mismas nueve piezas para los tres personajes; cada uno enseña sólo las
// suyas (ver `.cos-skin[data-char]` en globals.css). Caja de 58×58: a ese
// tamaño es la mascota, a 0.517 la cara de 30px del panel y en las tarjetas
// del selector.

export function PetSkin({
  char,
  color,
  className,
  style,
  pupilaRef,
}: {
  char: IdPersonaje;
  color: string;
  className?: string;
  style?: CSSProperties;
  /** Las pupilas (o el brillo del shiba), para seguir al cursor. */
  pupilaRef?: (lado: 0 | 1) => Ref<HTMLElement>;
}) {
  return (
    <span
      data-char={char}
      className={cn("cos-skin", className)}
      style={{ ...style, ["--pet-c" as string]: color } as CSSProperties}
      aria-hidden
    >
      <span className="ear l" />
      <span className="ear r" />
      <span className="mask" />
      <span className="brow l" />
      <span className="brow r" />
      <span className="eye l">
        <i ref={pupilaRef?.(0)} />
      </span>
      <span className="eye r">
        <i ref={pupilaRef?.(1)} />
      </span>
      <span className="bridge" />
      <span className="nose" />
    </span>
  );
}

/** La cara de 30px del encabezado del panel. */
export function PetFace({ char, color }: { char: IdPersonaje; color: string }) {
  return (
    <span className="relative block h-[30px] w-[30px] flex-none" aria-hidden>
      <PetSkin char={char} color={color} className="absolute left-0 top-0 origin-top-left scale-[.517]" />
    </span>
  );
}
