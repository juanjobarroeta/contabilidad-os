import { sanearRef, type RefCopiloto } from "./tarjetas";

// ─────────────────────────────────────────────────────────────────────────────
// OBJETIVOS DE LA MASCOTA — qué se puede explicar en pantalla.
//
// El prototipo adivinaba los objetivos por clases CSS y por `innerText`. Aquí
// no: un elemento explicable lo dice a propósito con `data-copiloto`, que trae
// su tipo, su id y su título. Así la explicación es sobre ESE registro, no
// sobre lo que el texto de la tarjeta parezca decir.
//
//   <div data-copiloto={atributoCopiloto({ tipo: "obligacion", id, titulo })}>
// ─────────────────────────────────────────────────────────────────────────────

export const ATRIBUTO = "data-copiloto";
const SELECTOR = `[${ATRIBUTO}]`;

/** Serializa la referencia para el atributo. */
export function atributoCopiloto(ref: Omit<RefCopiloto, "ruta">): string {
  return JSON.stringify(ref);
}

/** El elemento explicable más cercano a un nodo (o null). */
export function objetivoDesde(nodo: Element | null): HTMLElement | null {
  return (nodo?.closest(SELECTOR) as HTMLElement | null) ?? null;
}

/** El elemento explicable bajo un punto de la pantalla. */
export function objetivoEn(x: number, y: number): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return objetivoDesde(document.elementFromPoint(x, y));
}

/** Lee y sanea la referencia de un elemento. Un atributo malformado no es un objetivo. */
export function leerObjetivo(el: Element, ruta?: string): RefCopiloto | null {
  const raw = el.getAttribute(ATRIBUTO);
  if (!raw) return null;
  try {
    return sanearRef({ ...JSON.parse(raw), ruta });
  } catch {
    return null;
  }
}
