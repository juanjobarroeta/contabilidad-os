// ─────────────────────────────────────────────────────────────────────────────
// Parser del Código de Claves Vehiculares (Anexo 15 RMF, sección C).
//
// El texto plano del Anexo tiene esta forma (real, DOF 28-dic-2025):
//
//   Clave Empresa 01 : Stellantis México, S.A. de C.V. (antes FCA México…)
//   Modelo 31 : Ram 1500 (nacional)
//   1013114 Versión 14 : Ram 1500 Crew Cab, aut., 3.0 lts., turbo, 6 cil.
//   2010225 25 : Ram 4000, Regular Cab, aut., 6.7 lts., turbo diesel, 6 cil.
//
// Reglas aprendidas del documento real:
//   • La clave son 7 caracteres (tipo+empresa+modelo+versión) y puede terminar
//     en letras ("00559AR" — Porsche 911).
//   • La primera versión de un modelo dice "Versión NN :"; las siguientes solo
//     "NN :".
//   • Las descripciones se parten en renglones (continuación sin clave).
//   • Hay encabezados de página del DOF y marcadores "-- N of 14 --" a ignorar.
//
// Cada Anexo anual publica solo las claves NUEVAS: la cobertura del catálogo
// crece con cada ingesta. Parser puro; la ingesta a DB vive en
// scripts/automotriz-ingest-claves.mjs.
// ─────────────────────────────────────────────────────────────────────────────

export interface ClaveVehicularEntry {
  clave: string; // 7 caracteres
  empresa: string;
  modelo: string;
  version: string;
}

const RE_EMPRESA = /^Clave\s+Empresa\s+\w+\s*:\s*(.+)$/i;
const RE_MODELO = /^Modelo\s+\w+\s*:\s*(.+)$/i;
// "1013114 Versión 14 : desc"  |  "2010225 25 : desc"
const RE_VERSION = /^([0-9A-Z]{7})\s+(?:Versi[oó]n\s+)?[0-9A-Z]{1,2}\s*:\s*(.+)$/;
// Ruido del DOF / estructura del documento — nunca es contenido del catálogo.
const RE_RUIDO =
  /^(--\s*\d+\s*of\s*\d+\s*--|DIARIO OFICIAL.*|.*DIARIO OFICIAL|(Lunes|Martes|Mi[eé]rcoles|Jueves|Viernes|S[aá]bado|Domingo)\s+\d+.*|[A-C]\.\s.+|\d\.\s.*|TARIFA.*|Art[ií]culo.*)$/i;

/**
 * Extrae las entradas del catálogo de una publicación del Anexo 15 en texto
 * plano. Tolerante a ruido: ignora lo que no entiende, y pega renglones de
 * continuación a la descripción de la última versión vista.
 */
export function parseAnexo15Claves(texto: string): ClaveVehicularEntry[] {
  const entries: ClaveVehicularEntry[] = [];
  let empresa: string | null = null;
  let modelo: string | null = null;
  let ultima: ClaveVehicularEntry | null = null;

  for (const raw of texto.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || RE_RUIDO.test(line)) continue;

    const mEmpresa = line.match(RE_EMPRESA);
    if (mEmpresa) {
      empresa = mEmpresa[1].trim();
      modelo = null;
      ultima = null;
      continue;
    }

    const mModelo = line.match(RE_MODELO);
    if (mModelo) {
      modelo = mModelo[1].trim();
      ultima = null;
      continue;
    }

    const mVersion = line.match(RE_VERSION);
    if (mVersion && empresa && modelo) {
      ultima = {
        clave: mVersion[1],
        empresa,
        modelo,
        version: mVersion[2].trim(),
      };
      entries.push(ultima);
      continue;
    }

    // Renglón de continuación de la descripción (wrap del PDF).
    if (ultima && !/^Clave\s/i.test(line)) {
      ultima.version = `${ultima.version} ${line}`.trim();
    }
  }

  return entries;
}

/**
 * Limpia el modelo del Anexo para mostrarlo como modelo de la unidad:
 * quita "(nacional)"/"(importado)" y anotaciones tipo "Marca GML".
 */
export function modeloLimpio(modeloAnexo: string): string {
  return modeloAnexo
    .replace(/\((nacional|importado)\)/gi, "")
    .replace(/\bMarca\s+\w+\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
