// ─────────────────────────────────────────────────────────────────────────────
// Descarga del "Listado completo" 69-B del SAT (CSV público, ~14k filas). El
// archivo viene en codificación Windows-1252 (acentos en "Situación"), por eso
// se decodifica explícitamente antes de parsear. URL configurable por si el SAT
// la cambia.
// ─────────────────────────────────────────────────────────────────────────────

import { parseEfosCsv } from "./parse";
import type { ListaEfos } from "./types";

export const EFOS_URL_DEFAULT =
  "http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv";

export async function descargarListaEfos(
  url: string = process.env.EFOS_LIST_URL ?? EFOS_URL_DEFAULT,
): Promise<ListaEfos> {
  // Con tope: el SAT a veces tarda minutos, y quien espera esta lista es un
  // request de usuario (Directorio, Verificador). Mejor sin badge que colgado.
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new Error(`No se pudo descargar la lista 69-B (HTTP ${res.status}).`);
  }
  const buf = await res.arrayBuffer();
  const csv = new TextDecoder("windows-1252").decode(buf);
  const lista = parseEfosCsv(csv);
  if (lista.size === 0) {
    throw new Error("La lista 69-B se descargó vacía — ¿cambió el formato o la URL del SAT?");
  }
  return lista;
}
