// ─────────────────────────────────────────────────────────────────────────────
// Captura asistida — de lo que el modelo contestó a `secciones` de la nota.
//
// El modelo recibe la plantilla, pero el código no confía en que la respete:
// aquí se conservan sólo las claves de PLANTILLAS_NOTA[tipo] (las demás se
// descartan y se reportan), las escalas se convierten a entero (o se
// descartan con advertencia), el ASA se normaliza, lo vacío se omite y las
// obligatorias que no quedaron son `faltantes`. Puro: sin base ni modelo.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospNotaTipo } from "@prisma/client";
import { ETIQUETA_SECCION, PLANTILLAS_NOTA, normalizarAsa } from "../notas";
import { CLAVES_ESCALA } from "./prompts";

export type ValorSeccion = string | number;

export interface SeccionesMapeadas {
  secciones: Record<string, ValorSeccion>;
  /** Claves obligatorias de la plantilla que quedaron sin contenido. */
  faltantes: string[];
  /** Claves que el modelo inventó y no están en la plantilla. */
  descartadas: string[];
  advertencias: string[];
  /** Cuántos datos vienen marcados «[verificar]». */
  porVerificar: number;
}

const RANGO_ESCALA: Record<(typeof CLAVES_ESCALA)[number], [number, number]> = {
  aldrete: [0, 10],
  triageNivel: [1, 5],
  dolor: [0, 10],
};

function textoDe(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const partes = v.map(textoDe).filter((x): x is string => !!x);
    return partes.length ? partes.join("; ") : null;
  }
  return null;
}

function enteroDe(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    const m = /^\s*(\d{1,2})\s*(?:\/\s*10)?\s*$/.exec(v);
    if (m) return Number(m[1]);
  }
  return null;
}

const MARCA_VERIFICAR = /\[verificar\]/gi;

/**
 * Mapea la respuesta del modelo a las secciones de la plantilla del tipo.
 * Nunca lanza: lo que no cabe se descarta y se explica en `advertencias`.
 */
export function mapearSecciones(tipo: HospNotaTipo, entrada: unknown): SeccionesMapeadas {
  const plantilla = PLANTILLAS_NOTA[tipo];
  const permitidas = new Set<string>([...plantilla.obligatorias, ...plantilla.opcionales]);
  const secciones: Record<string, ValorSeccion> = {};
  const descartadas: string[] = [];
  const advertencias: string[] = [];
  let porVerificar = 0;

  const obj = entrada && typeof entrada === "object" && !Array.isArray(entrada) ? (entrada as Record<string, unknown>) : {};
  for (const [clave, valor] of Object.entries(obj)) {
    if (!permitidas.has(clave)) {
      if (textoDe(valor)) descartadas.push(clave);
      continue;
    }
    if ((CLAVES_ESCALA as readonly string[]).includes(clave)) {
      const escala = clave as (typeof CLAVES_ESCALA)[number];
      const n = enteroDe(valor);
      if (n == null) {
        if (textoDe(valor)) advertencias.push(`${ETIQUETA_SECCION[clave] ?? clave}: el asistente propuso «${textoDe(valor)}», que no es un entero; captúralo a mano`);
        continue;
      }
      const [min, max] = RANGO_ESCALA[escala];
      if (n < min || n > max) {
        advertencias.push(`${ETIQUETA_SECCION[clave] ?? clave}: ${n} está fuera del rango ${min}-${max}; revísalo`);
        continue;
      }
      secciones[clave] = n;
      continue;
    }
    const texto = textoDe(valor);
    if (!texto) continue;
    if (clave === "asa") {
      try {
        const asa = normalizarAsa(texto.replace(/^asa\s*/i, ""));
        if (asa) secciones.asa = asa;
      } catch {
        advertencias.push(`Clasificación ASA: el asistente propuso «${texto}», que no es una clase válida (I-VI, con E si es urgencia)`);
      }
      continue;
    }
    porVerificar += (texto.match(MARCA_VERIFICAR) ?? []).length;
    secciones[clave] = texto;
  }

  const faltantes = plantilla.obligatorias.filter((s) => secciones[s] === undefined);
  if (faltantes.length) {
    advertencias.push(`Faltan secciones obligatorias de la ${plantilla.titulo.toLowerCase()}: ${faltantes.map((s) => ETIQUETA_SECCION[s] ?? s).join(", ")} (${plantilla.fundamento})`);
  }
  if (descartadas.length) advertencias.push(`El asistente propuso secciones que no están en la plantilla y se descartaron: ${descartadas.join(", ")}`);
  if (porVerificar) advertencias.push(`${porVerificar} dato${porVerificar === 1 ? "" : "s"} marcado${porVerificar === 1 ? "" : "s"} [verificar]: el asistente no estuvo seguro de lo que oyó`);

  return { secciones, faltantes, descartadas, advertencias, porVerificar };
}

/** Lista de strings del modelo, sin vacíos ni basura. */
export function listaTextos(v: unknown, max = 20): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .slice(0, max);
}
