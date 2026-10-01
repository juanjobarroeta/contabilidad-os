// ─────────────────────────────────────────────────────────────────────────────
// LOS PERSONAJES DEL COPILOTO — sólo cambia cómo se ve.
//
// Tres personajes (Cubo, Mochi, Lupa), cuatro colores cada uno y un nombre
// opcional. La memoria, las respuestas y el comportamiento son los mismos: es
// una piel. Todo es CSS (ver `.cos-skin` en globals.css), sin imágenes, así
// que escala y se recolorea con una sola variable (`--pet-c`).
//
// Puro: lo usan la mascota, la cara del panel y la vista «Personalizar».
// ─────────────────────────────────────────────────────────────────────────────

export type IdPersonaje = "blob" | "shiba" | "owl";

export interface Personaje {
  /** Nombre por default (el que se usa si el usuario no pone uno). */
  label: string;
  desc: string;
  /** [nombre del color, valor CSS]. */
  colores: readonly (readonly [string, string])[];
  /** Cuánto se mueven las pupilas (o el brillo) al seguir el cursor. */
  mirada: number;
}

export const PERSONAJES: Record<IdPersonaje, Personaje> = {
  blob: {
    label: "Cubo",
    desc: "El de la marca. Sobrio.",
    colores: [
      ["Azul", "oklch(0.55 0.16 258)"],
      ["Jade", "oklch(0.58 0.11 168)"],
      ["Grafito", "oklch(0.36 0.02 258)"],
      ["Ciruela", "oklch(0.50 0.14 330)"],
    ],
    mirada: 1,
  },
  shiba: {
    label: "Mochi",
    desc: "Shiba inu. Leal y atento.",
    colores: [
      ["Rojo", "oklch(0.70 0.15 55)"],
      ["Sésamo", "oklch(0.55 0.09 50)"],
      ["Negro", "oklch(0.32 0.02 40)"],
      ["Crema", "oklch(0.88 0.05 80)"],
    ],
    mirada: 0.6,
  },
  owl: {
    label: "Lupa",
    desc: "Búho con lentes. Para el detalle.",
    colores: [
      ["Pizarra", "oklch(0.52 0.05 258)"],
      ["Café", "oklch(0.52 0.07 55)"],
      ["Bosque", "oklch(0.50 0.07 150)"],
      ["Nieve", "oklch(0.90 0.01 258)"],
    ],
    mirada: 1.1,
  },
};

export const IDS_PERSONAJE = Object.keys(PERSONAJES) as IdPersonaje[];
export const MAX_NOMBRE = 16;

/** Lo que se guarda (localStorage `cos-pet-skin`). */
export interface Piel {
  char: IdPersonaje;
  /** null = el nombre por default del personaje. */
  name: string | null;
  /** Color elegido POR personaje (índice en `colores`): cambiar de personaje no pierde el color del otro. */
  colors: Partial<Record<IdPersonaje, number>>;
}

export const PIEL_DEFAULT: Piel = { char: "blob", name: null, colors: {} };

/** Sanea lo leído de localStorage: un valor viejo o corrupto vuelve al default. */
export function sanearPiel(v: unknown): Piel {
  if (!v || typeof v !== "object") return { ...PIEL_DEFAULT, colors: {} };
  const o = v as Record<string, unknown>;
  const char = IDS_PERSONAJE.includes(o.char as IdPersonaje) ? (o.char as IdPersonaje) : "blob";
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, MAX_NOMBRE) : null;
  const colors: Piel["colors"] = {};
  if (o.colors && typeof o.colors === "object") {
    for (const id of IDS_PERSONAJE) {
      const i = (o.colors as Record<string, unknown>)[id];
      if (typeof i === "number" && Number.isInteger(i) && i >= 0 && i < PERSONAJES[id].colores.length) colors[id] = i;
    }
  }
  return { char, name, colors };
}

export function indiceColor(piel: Piel, char: IdPersonaje = piel.char): number {
  return piel.colors[char] ?? 0;
}

export function colorDe(piel: Piel, char: IdPersonaje = piel.char): string {
  return PERSONAJES[char].colores[indiceColor(piel, char)][1];
}

export function nombreDe(piel: Piel): string {
  return piel.name || PERSONAJES[piel.char].label;
}
