"use client";

import type { IdPersonaje } from "@/lib/copiloto/personajes";
import { PetSkin } from "./PetSkin";

// Mientras el copiloto trabaja: la mascota pensando (se ladea, mira hacia
// arriba y le salen puntitos) y, si está usando una herramienta, qué hace.
// Reemplaza al aviso amarillo con la llave inglesa y a los tres puntos.
export function PetPensando({ char, color, nombre, texto }: { char: IdPersonaje; color: string; nombre: string; texto: string }) {
  return (
    <div className="cos-pensando flex items-center gap-2.5 self-start" role="status" aria-live="polite">
      <span className="relative block h-[34px] w-[34px] flex-none" aria-hidden>
        <span className="cos-pensando-burbuja" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <PetSkin char={char} color={color} className="cos-pensando-pet absolute left-0 top-0 origin-top-left scale-[.586]" />
      </span>
      <span className="text-[13px] text-cos-ink-soft">
        <b className="font-semibold text-cos-ink">{nombre}</b> · {texto}
      </span>
    </div>
  );
}
