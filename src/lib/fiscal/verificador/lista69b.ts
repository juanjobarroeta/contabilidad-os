// ─────────────────────────────────────────────────────────────────────────────
// Consulta puntual 69-B para el Verificador. La lista del SAT (~14k filas) se
// descarga completa (misma pieza que usa el cron efos-screening) y se cachea
// EN MEMORIA con TTL: la lista cambia unas cuantas veces al mes, y así la
// primera consulta del día paga la descarga (~1-2 s) y las demás responden al
// instante. Sin persistencia — el proceso puede reiniciar y sólo se re-baja.
// ─────────────────────────────────────────────────────────────────────────────

import { descargarListaEfos } from "../efos/download";
import type { ListaEfos, SituacionEfos } from "../efos/types";

const TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

let cache: { lista: ListaEfos; fetchedAt: number } | null = null;
let enVuelo: Promise<ListaEfos> | null = null;

async function obtenerLista(): Promise<{ lista: ListaEfos; fetchedAt: number }> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  // Descargas concurrentes comparten el mismo fetch.
  if (!enVuelo) {
    enVuelo = descargarListaEfos().finally(() => {
      enVuelo = null;
    });
  }
  const lista = await enVuelo;
  cache = { lista, fetchedAt: Date.now() };
  return cache;
}

export type Consulta69b = {
  /** null = el RFC NO aparece en la lista 69-B (lo deseable). */
  situacion: SituacionEfos | null;
  /** Cuándo se descargó la lista con la que se respondió. */
  listaDescargadaAt: string;
  rfcsEnLista: number;
};

export async function consultar69b(rfc: string): Promise<Consulta69b> {
  const { lista, fetchedAt } = await obtenerLista();
  return {
    situacion: lista.get(rfc.trim().toUpperCase()) ?? null,
    listaDescargadaAt: new Date(fetchedAt).toISOString(),
    rfcsEnLista: lista.size,
  };
}

/** Situaciones 69-B para un lote de RFCs (una sola carga de la lista, cacheada
 *  12 h). Sólo devuelve entradas para RFCs QUE APARECEN en la lista — el
 *  Directorio pinta el badge únicamente cuando hay algo que señalar. */
export async function situaciones69b(rfcs: string[]): Promise<Map<string, string>> {
  if (rfcs.length === 0) return new Map();
  const { lista } = await obtenerLista();
  const out = new Map<string, string>();
  for (const rfc of rfcs) {
    const sit = lista.get(rfc.trim().toUpperCase());
    if (sit === "PRESUNTO" || sit === "DEFINITIVO") out.set(rfc, sit);
  }
  return out;
}
