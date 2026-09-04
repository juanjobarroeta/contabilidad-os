// ─────────────────────────────────────────────────────────────────────────────
// Localización y descarga de los anexos de la RMF en el minisitio del SAT.
//
// El SAT no publica un índice consultable (el directorio responde 403), pero
// el nombre del archivo es predecible:
//   documentos{Y}/rmf/anexos/Anexo-{N}-RMF-{Y}_DOF-{DDMMYYYY}.pdf
// con la fecha del DOF en que salió (fin de diciembre del año anterior, a veces
// enero). Se prueban las fechas candidatas; una URL explícita (env o input del
// workflow) gana siempre — sirve para modificaciones a mitad de año.
// ─────────────────────────────────────────────────────────────────────────────

import { descargarBinario, existeUrl, textoDePdf } from "./texto";

const BASE = "https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE";

function ddmmyyyy(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}${String(d.getUTCMonth() + 1).padStart(2, "0")}${d.getUTCFullYear()}`;
}

/** URLs candidatas del anexo N para el ejercicio, de la más probable a la menos. Puro. */
export function urlsCandidatasAnexo(numero: number, ejercicio: number): string[] {
  const fechas: Date[] = [];
  // 31-dic → 15-dic del año anterior, luego 1-ene → 31-ene del ejercicio.
  for (let d = 31; d >= 15; d--) fechas.push(new Date(Date.UTC(ejercicio - 1, 11, d)));
  for (let d = 1; d <= 31; d++) fechas.push(new Date(Date.UTC(ejercicio, 0, d)));
  return fechas.map((f) => `${BASE}/documentos${ejercicio}/rmf/anexos/Anexo-${numero}-RMF-${ejercicio}_DOF-${ddmmyyyy(f)}.pdf`);
}

export interface AnexoDescargado {
  url: string;
  texto: string;
}

/**
 * Descarga el anexo N del ejercicio y devuelve su texto. `url` explícita salta
 * la búsqueda. Lanza si ninguna candidata existe.
 */
export async function descargarAnexo(numero: number, ejercicio: number, url?: string): Promise<AnexoDescargado> {
  const candidatas = url ? [url] : urlsCandidatasAnexo(numero, ejercicio);
  for (const u of candidatas) {
    if (!url && !(await existeUrl(u))) continue;
    const buf = await descargarBinario(u);
    const texto = await textoDePdf(buf);
    if (texto.length < 5_000) throw new Error(`Anexo ${numero} ${ejercicio}: texto sospechosamente corto (${texto.length} chars) en ${u}`);
    return { url: u, texto };
  }
  throw new Error(`Anexo ${numero} RMF ${ejercicio}: no se encontró el PDF en el minisitio del SAT (probadas ${candidatas.length} fechas). Pasa la URL explícita.`);
}
