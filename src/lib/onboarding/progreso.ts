// ─────────────────────────────────────────────────────────────────────────────
// PROGRESO DEL ONBOARDING CON MASCOTA — por usuario (User.onboarding, JSON).
//
// Guarda la pantalla en la que va, la empresa que se está dando de alta, el
// perfil (despacho / empresa) y el tono del copiloto, para que recargar la
// página retome donde se quedó. Puro: lo usan la ruta y la UI.
// ─────────────────────────────────────────────────────────────────────────────

import { rutaRetornoSegura } from "@/lib/ruta-retorno";

/** Pantallas del alta, en orden. `recorrido` y `app` viven ya dentro de la app. */
export const PASOS = ["hola", "personaje", "confianza", "fiel", "historial", "bancos", "equipo", "whatsapp", "recorrido", "app", "listo"] as const;
export type Paso = (typeof PASOS)[number];

/** Las que pinta /onboarding (las demás corren dentro de la app). */
export const PASOS_ALTA = ["hola", "personaje", "confianza", "fiel", "historial", "bancos", "equipo", "whatsapp"] as const;
export type PasoAlta = (typeof PASOS_ALTA)[number];

export type Perfil = "despacho" | "empresa";
export type Tono = "grano" | "bal" | "calma";
export const TONOS: readonly Tono[] = ["grano", "bal", "calma"];

export interface Progreso {
  paso: Paso;
  companyId: string | null;
  perfil: Perfil | null;
  tono: Tono;
  /** true cuando el usuario eligió el tono (deja de seguir al perfil). */
  tonoElegido: boolean;
}

export const PROGRESO_INICIAL: Progreso = { paso: "hola", companyId: null, perfil: null, tono: "bal", tonoElegido: false };

/** Tono sugerido por perfil: el despacho domina el tema, el dueño no tiene por qué. */
export function tonoSugerido(perfil: Perfil | null): Tono {
  return perfil === "despacho" ? "grano" : perfil === "empresa" ? "calma" : "bal";
}

/** Sanea lo guardado (o lo que manda el cliente): lo inválido cae al default. */
export function sanearProgreso(v: unknown): Progreso {
  if (!v || typeof v !== "object") return { ...PROGRESO_INICIAL };
  const o = v as Record<string, unknown>;
  return {
    paso: PASOS.includes(o.paso as Paso) ? (o.paso as Paso) : "hola",
    companyId: typeof o.companyId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(o.companyId) ? o.companyId : null,
    perfil: o.perfil === "despacho" || o.perfil === "empresa" ? o.perfil : null,
    tono: TONOS.includes(o.tono as Tono) ? (o.tono as Tono) : "bal",
    tonoElegido: o.tonoElegido === true,
  };
}

/** Mezcla un cambio parcial sobre lo guardado; el paso nunca retrocede salvo que se pida. */
export function mezclarProgreso(actual: Progreso, cambio: Partial<Progreso>, opts: { permitirRetroceso?: boolean } = {}): Progreso {
  const siguiente = sanearProgreso({ ...actual, ...cambio });
  if (!opts.permitirRetroceso && PASOS.indexOf(siguiente.paso) < PASOS.indexOf(actual.paso)) siguiente.paso = actual.paso;
  return siguiente;
}

export const PASOS_AGREGAR = ["fiel", "historial", "listo"] as const;
export interface ProgresoAgregar {
  paso: (typeof PASOS_AGREGAR)[number];
  companyId: string | null;
  returnTo: string | null;
}

/** Separate from the user's first-run progress and companion preferences. */
export function sanearAgregar(v: unknown): ProgresoAgregar | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    paso: PASOS_AGREGAR.includes(o.paso as ProgresoAgregar["paso"]) ? o.paso as ProgresoAgregar["paso"] : "fiel",
    companyId: sanearProgreso(o).companyId,
    returnTo: rutaRetornoSegura(typeof o.returnTo === "string" ? o.returnTo : null),
  };
}

export function rutaManual(fromEmpresas: boolean, returnTo: string | null): string {
  const query = new URLSearchParams();
  if (fromEmpresas) query.set("from", "empresas");
  const safe = rutaRetornoSegura(returnTo);
  if (safe) query.set("returnTo", safe);
  return `/onboarding/manual${query.size ? `?${query}` : ""}`;
}
