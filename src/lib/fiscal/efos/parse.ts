// ─────────────────────────────────────────────────────────────────────────────
// Parser del "Listado completo" 69-B del SAT (CSV). El archivo trae filas de
// encabezado/título antes del header de columnas; se localiza la fila que
// contiene "RFC" y "Situación", y se leen esas dos columnas. Tolerante a comillas
// y acentos.
// ─────────────────────────────────────────────────────────────────────────────

import type { ListaEfos, SituacionEfos } from "./types";

/** Parte una línea CSV respetando comillas dobles. */
function parseLinea(linea: string): string[] {
  const out: string[] = [];
  let cur = "";
  let enComillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"') {
      if (enComillas && linea[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        enComillas = !enComillas;
      }
    } else if (c === "," && !enComillas) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const sinAcentos = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Normaliza el texto de "Situación del contribuyente" al enum. */
export function normalizarSituacion(texto: string): SituacionEfos | null {
  const t = sinAcentos(texto);
  if (t.includes("definitivo")) return "DEFINITIVO";
  if (t.includes("sentencia favorable")) return "SENTENCIA_FAVORABLE";
  if (t.includes("desvirtuado")) return "DESVIRTUADO";
  if (t.includes("presunto")) return "PRESUNTO";
  return null;
}

/**
 * Parsea el CSV del listado 69-B → Map RFC→situación. Ignora filas previas al
 * header y filas sin RFC/situación reconocibles.
 */
export function parseEfosCsv(csv: string): ListaEfos {
  const lista: ListaEfos = new Map();
  const lineas = csv.split(/\r?\n/);

  // Localiza el header: la fila con columnas "RFC" y "Situación".
  let headerIdx = -1;
  let colRfc = -1;
  let colSit = -1;
  for (let i = 0; i < lineas.length; i++) {
    const cols = parseLinea(lineas[i]).map(sinAcentos);
    const rfcIdx = cols.findIndex((c) => c === "rfc");
    const sitIdx = cols.findIndex((c) => c.startsWith("situacion del contribuyente") || c === "situacion");
    if (rfcIdx !== -1 && sitIdx !== -1) {
      headerIdx = i;
      colRfc = rfcIdx;
      colSit = sitIdx;
      break;
    }
  }
  if (headerIdx === -1) return lista;

  for (let i = headerIdx + 1; i < lineas.length; i++) {
    if (!lineas[i].trim()) continue;
    const cols = parseLinea(lineas[i]);
    const rfc = (cols[colRfc] ?? "").toUpperCase().trim();
    const sit = normalizarSituacion(cols[colSit] ?? "");
    if (!rfc || !sit) continue;
    // Si un RFC aparece varias veces, la situación más reciente del archivo gana.
    lista.set(rfc, sit);
  }
  return lista;
}
