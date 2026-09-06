// Lo que comparten los adaptadores (Tláloc, Nubarium) sin depender del
// selector de proveedor: la interfaz, el `fetch` con tope de tiempo y su
// firma inyectable para las pruebas.

import { RenapoError, type BusquedaRenapo, type CurpRecord, type ProveedorRenapoNombre } from "./tipos";

export interface ProveedorRenapo {
  readonly nombre: ProveedorRenapoNombre;
  consultarPorCurp(curp: string): Promise<CurpRecord>;
  buscarPorDatos(q: BusquedaRenapo): Promise<CurpRecord[]>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const TIMEOUT_RENAPO_MS = 10_000;

/** `fetch` con tope de tiempo; agotado o sin red → UPSTREAM_UNAVAILABLE. */
export async function fetchConTimeout(url: string, init: RequestInit, ms: number = TIMEOUT_RENAPO_MS, fetchImpl: FetchLike = fetch): Promise<Response> {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: control.signal });
  } catch (e) {
    if (e instanceof RenapoError) throw e;
    const abortado = (e as { name?: string })?.name === "AbortError" || control.signal.aborted;
    throw new RenapoError("UPSTREAM_UNAVAILABLE", abortado ? `RENAPO no respondió en ${Math.round(ms / 1000)} s` : "No se pudo conectar con el proveedor de RENAPO");
  } finally {
    clearTimeout(timer);
  }
}
