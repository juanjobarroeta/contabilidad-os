// ─────────────────────────────────────────────────────────────────────────────
// DÓNDE ABRE LA BURBUJA (y el panel) respecto a la mascota.
//
// Hacia el lado con más espacio: si el centro de la mascota pasó la mitad de
// la pantalla, abre a su izquierda; si no, a su derecha, con 12px de aire. Si
// no cabe de lado, centrado encima (o debajo si tampoco). La burbuja se alinea
// con el borde superior de la mascota; el panel, con el inferior. Siempre a
// 12px de los bordes. Puro: se prueba sin DOM.
// ─────────────────────────────────────────────────────────────────────────────

export interface Caja {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const MARGEN = 12;
export const TAM_MASCOTA = 58;
export const BORDE_MASCOTA = 8;
export const ESQUINA_MASCOTA = 28;

export function colocarJunto(
  mascota: Caja,
  ancho: number,
  alto: number,
  vw: number,
  vh: number,
  modo: "burbuja" | "panel",
): { x: number; y: number } {
  const derecha = mascota.left + mascota.width / 2 > vw / 2;
  let x = derecha ? mascota.left - ancho - MARGEN : mascota.left + mascota.width + MARGEN;
  let y = modo === "panel" ? mascota.top + mascota.height - alto : mascota.top - 4;
  if (x < MARGEN || x + ancho > vw - MARGEN) {
    x = Math.max(MARGEN, Math.min(vw - ancho - MARGEN, mascota.left + mascota.width / 2 - ancho / 2));
    y = mascota.top - alto - MARGEN;
    if (y < MARGEN) y = mascota.top + mascota.height + MARGEN;
  }
  return { x, y: Math.max(MARGEN, Math.min(vh - alto - MARGEN, y)) };
}

/** Mantiene la mascota dentro de la pantalla, a 8px de los bordes. */
export function acotarMascota(x: number, y: number, vw: number, vh: number, tam = TAM_MASCOTA): { x: number; y: number } {
  return {
    x: Math.max(BORDE_MASCOTA, Math.min(vw - tam - BORDE_MASCOTA, x)),
    y: Math.max(BORDE_MASCOTA, Math.min(vh - tam - BORDE_MASCOTA, y)),
  };
}

/** La esquina de casa: abajo a la derecha, con 28px de margen. */
export function esquinaMascota(vw: number, vh: number, tam = TAM_MASCOTA): { x: number; y: number } {
  return { x: vw - tam - ESQUINA_MASCOTA, y: vh - tam - ESQUINA_MASCOTA };
}

/** Ojos que siguen al cursor: vector unitario × (2.5, 3.5) × min(1, d/180). */
export function miradaPupila(centroX: number, centroY: number, x: number, y: number): { dx: number; dy: number } {
  const ax = x - centroX;
  const ay = y - centroY;
  const d = Math.hypot(ax, ay) || 1;
  const k = Math.min(1, d / 180);
  return { dx: (ax / d) * 2.5 * k, dy: (ay / d) * 3.5 * k };
}
