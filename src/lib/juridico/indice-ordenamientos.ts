// El índice de títulos → clave con el que se reconocen las citas en prosa.
// Sale de los JSON del catálogo (no de la base): se arma una vez por proceso y
// no cuesta una consulta por turno.
import { construirIndice, type EntradaIndice } from "@/lib/ai/citas-prosa";

type Entrada = { clave: string; titulo: string; entidad?: string | null };

let cache: EntradaIndice[] | null = null;

export function indiceOrdenamientos(): EntradaIndice[] {
  if (cache) return cache;
  const entradas: Entrada[] = [];
  for (const archivo of ["federal.json", "estatales.json", "reglamentos-federales.json", "nom.json", "ojn.json"]) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const json = require(`@/lib/fiscal-kb/catalogo/${archivo}`) as { entradas?: Entrada[] } | Entrada[];
      const lista = Array.isArray(json) ? json : (json.entradas ?? []);
      for (const e of lista) if (e?.clave && e?.titulo) entradas.push(e);
    } catch {
      /* un catálogo que falte no debe tumbar el turno */
    }
  }
  cache = construirIndice(entradas);
  return cache;
}
