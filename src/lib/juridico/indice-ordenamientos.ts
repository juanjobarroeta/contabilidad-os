// El índice de títulos → clave con el que se reconocen las citas en prosa.
//
// Los catálogos se importan ESTÁTICAMENTE, como en ingest-leyes.ts. Con un
// `require()` dinámico —una plantilla con alias— webpack no resuelve nada, el
// catch se lo traga y el índice queda vacío: en producción ninguna cita en
// prosa se reconocía, mientras que en local (tsx, resolución de Node) sí. Se
// arma una vez por proceso; no cuesta consultas.
import federal from "@/lib/fiscal-kb/catalogo/federal.json";
import estatales from "@/lib/fiscal-kb/catalogo/estatales.json";
import reglamentos from "@/lib/fiscal-kb/catalogo/reglamentos-federales.json";
import nom from "@/lib/fiscal-kb/catalogo/nom.json";
import ojn from "@/lib/fiscal-kb/catalogo/ojn.json";
import { construirIndice, type EntradaIndice } from "@/lib/ai/citas-prosa";

type Entrada = { clave?: string; titulo?: string; entidad?: string | null };
type Catalogo = { entradas?: Entrada[] } | Entrada[];

let cache: EntradaIndice[] | null = null;

function entradasDe(c: Catalogo): Entrada[] {
  return Array.isArray(c) ? c : (c.entradas ?? []);
}

export function indiceOrdenamientos(): EntradaIndice[] {
  if (cache) return cache;
  const todas: { clave: string; titulo: string; entidad?: string | null }[] = [];
  for (const c of [federal, estatales, reglamentos, nom, ojn] as Catalogo[]) {
    for (const e of entradasDe(c)) {
      if (typeof e?.clave === "string" && typeof e?.titulo === "string") todas.push({ clave: e.clave, titulo: e.titulo, entidad: e.entidad ?? null });
    }
  }
  cache = construirIndice(todas);
  return cache;
}

/** Para las pruebas: cuántos ordenamientos quedaron en el índice. */
export function tamanoIndice(): number {
  return indiceOrdenamientos().length;
}
