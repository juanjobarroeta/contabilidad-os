// ─────────────────────────────────────────────────────────────────────────────
// Jurisprudencia de la SCJN (docs/MOTOR-JURIDICO.md F1): del JSON del API de
// datos abiertos del Repositorio del Bicentenario a lo que guarda la base.
//
// Todo lo de este archivo es PURO (sin red ni base) y está probado: las fechas
// salen de la «nota de publicación» (que dice desde cuándo la tesis es
// obligatoria), la Época se abrevia como la citan los abogados («11a.»), las
// materias del SJF se traducen a la taxonomía de materias.ts y el estado del
// criterio (vigente / interrumpida / sustituida / superada) se lee de las notas.
// ─────────────────────────────────────────────────────────────────────────────

import type { Materia } from "../materias";

/** Objeto Tesis tal como lo devuelve GET …/api/v1/tesis/:id. */
export interface TesisSjf {
  idTesis: number;
  rubro: string;
  texto: string;
  precedentes: string;
  epoca: string; // «Undécima Época»
  instancia: string; // «Suprema Corte de Justicia de la Nación» | «Tribunales Colegiados de Circuito» | …
  organoJuris: string; // «Primera Sala», «SEGUNDO TRIBUNAL COLEGIADO DEL VIGÉSIMO SEXTO CIRCUITO.»
  fuente: string;
  tesis: string; // número de identificación: «1a./J. 215/2025 (11a.)»
  tipoTesis: string; // «Jurisprudencia» | «Tesis Aislada»
  localizacion: string;
  anio: number;
  mes: string;
  notaPublica: string;
  anexos: string;
  huellaDigital: string; // SHA-256
  materias: string[]; // «Civil», «Constitucional», «Administrativa», «Común»…
}

export type TipoCriterio = "JURISPRUDENCIA" | "AISLADA";
export type EstadoCriterio = "VIGENTE" | "INTERRUMPIDA" | "SUSTITUIDA" | "SUPERADA";

/** Lo que se guarda: un FiscalDocument (source TESIS) con uno o más chunks. */
export interface TesisNormalizada {
  clave: string; // «SJF-2031002»
  registro: string; // «2031002»
  numeroTesis: string | null;
  titulo: string; // rubro
  url: string;
  epoca: string | null; // «11a.»
  instancia: string | null;
  organo: string | null;
  tipoCriterio: TipoCriterio;
  estadoCriterio: EstadoCriterio;
  fechaPublicacion: Date | null;
  /** Desde cuándo obliga (nota de publicación) o, si no se sabe, la publicación. */
  vigenciaDesde: Date;
  hash: string;
  materias: Materia[];
  contexto: string;
  chunks: { texto: string; parte: number | null }[];
}

export const SJF_BASE = "https://bicentenario.scjn.gob.mx/repositorio-scjn";
export const SJF_API = `${SJF_BASE}/api/v1`;
export const SJF_URL_DETALLE = (registro: string) => `https://sjf2.scjn.gob.mx/detalle/tesis/${registro}`;
export const claveTesis = (registro: string | number) => `SJF-${registro}`;

const EPOCAS: Record<string, number> = {
  primera: 1, segunda: 2, tercera: 3, cuarta: 4, quinta: 5, sexta: 6, séptima: 7, septima: 7, octava: 8, novena: 9,
  décima: 10, decima: 10, undécima: 11, undecima: 11, duodécima: 12, duodecima: 12,
};

/** «Undécima Época» → «11a.»; «11a. Época» → «11a.»; desconocida → null. */
export function epocaCorta(epoca: string | null | undefined): string | null {
  if (!epoca) return null;
  const num = epoca.match(/(\d{1,2})a\./);
  if (num) return `${num[1]}a.`;
  const palabra = epoca.trim().toLowerCase().split(/\s+/)[0];
  const n = EPOCAS[palabra];
  return n ? `${n}a.` : null;
}

export function tipoCriterioDe(tipoTesis: string | null | undefined): TipoCriterio {
  return /jurisprud/i.test(tipoTesis ?? "") ? "JURISPRUDENCIA" : "AISLADA";
}

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const RE_FECHA = /(\d{1,2})\s+de\s+([a-záéíóú]+)\s+(?:de\s+)?(\d{4})/i;

function fechaEn(texto: string, desde: number): Date | null {
  const m = texto.slice(desde).match(RE_FECHA);
  if (!m) return null;
  const mes = MESES[m[2].toLowerCase()];
  return mes ? utc(Number(m[3]), mes, Number(m[1])) : null;
}

/**
 * Fechas de la nota de publicación: «Esta tesis se publicó el viernes 22 de
 * agosto de 2025 … y, por ende, se considera de aplicación obligatoria a partir
 * del lunes 25 de agosto de 2025». Sin nota (Épocas viejas): el primer día del
 * mes/año de publicación.
 */
export function fechasDe(t: Pick<TesisSjf, "notaPublica" | "anio" | "mes">): { publicacion: Date | null; obligatoria: Date | null; respaldo: Date } {
  const nota = t.notaPublica ?? "";
  const iPub = nota.search(/se public[óo]/i);
  const publicacion = iPub >= 0 ? fechaEn(nota, iPub) : null;
  const iObl = nota.search(/obligatoria a partir/i);
  const obligatoria = iObl >= 0 ? fechaEn(nota, iObl) : null;
  const mes = MESES[(t.mes ?? "").toLowerCase()] ?? 1;
  const anio = Number.isFinite(t.anio) && t.anio > 1900 ? t.anio : 1917;
  return { publicacion, obligatoria, respaldo: utc(anio, mes, 1) };
}

/**
 * Materias del SJF → taxonomía propia. «Administrativa» cubre lo fiscal en el
 * SJF (no hay materia «Fiscal»), así que una tesis administrativa que habla de
 * impuestos gana también «fiscal», y una que habla del IMSS/INFONAVIT gana
 * «seguridad_social» — es lo que hace que el contador la vea.
 */
const MAPA: Record<string, Materia[]> = {
  constitucional: ["constitucional"],
  penal: ["penal"],
  civil: ["civil"],
  administrativa: ["administrativo"],
  laboral: ["laboral"],
  común: ["amparo", "procesal"],
  comun: ["amparo", "procesal"],
  agraria: ["agrario"],
  electoral: ["electoral"],
  familiar: ["familiar"],
  mercantil: ["mercantil"],
  fiscal: ["fiscal"],
  militar: ["militar"],
  internacional: ["internacional"],
  ambiental: ["ambiental"],
};
const RE_FISCAL = /\bIMPUESTO|FISCAL|CONTRIBU(?:CI[ÓO]N|YENTE)|TRIBUTAR|DEDUC(?:CI[ÓO]N|IBLE)|SOBRE LA RENTA|VALOR AGREGADO|C[ÓO]DIGO FISCAL|DEVOLUCI[ÓO]N|RECARGOS|SERVICIO DE ADMINISTRACI[ÓO]N TRIBUTARIA|\bSAT\b|COMPROBANTE[S]? FISCAL|ADUAN|COMERCIO EXTERIOR|CR[ÉE]DITO FISCAL|CONTENCIOSO ADMINISTRATIVO/i;
const RE_SEGSOC = /SEGURO SOCIAL|\bIMSS\b|INFONAVIT|CUOTAS OBRERO|SALARIO BASE DE COTIZACI[ÓO]N|PENSI[ÓO]N|AFORE|SISTEMA DE AHORRO PARA EL RETIRO|ISSSTE/i;
const RE_PLD = /RECURSOS DE PROCEDENCIA IL[ÍI]CITA|LAVADO DE DINERO|ACTIVIDADES VULNERABLES/i;

export function materiasDeTesis(materiasSjf: readonly string[] | null | undefined, rubro: string): Materia[] {
  const out: Materia[] = [];
  const add = (ms: Materia[]) => {
    for (const m of ms) if (!out.includes(m)) out.push(m);
  };
  for (const raw of materiasSjf ?? []) {
    const k = raw.trim().toLowerCase();
    const ms = MAPA[k] ?? MAPA[k.normalize("NFD").replace(/[̀-ͯ]/g, "")];
    if (ms) add(ms);
  }
  if (RE_FISCAL.test(rubro)) add(["fiscal"]);
  if (RE_SEGSOC.test(rubro)) add(["seguridad_social", "laboral"]);
  if (RE_PLD.test(rubro)) add(["pld"]);
  return out.length > 0 ? out : ["administrativo"];
}

/**
 * Estado del criterio según las notas del SJF. La nota va en la tesis VIEJA:
 * «Esta tesis se interrumpió…», «fue superada por contradicción…», «ha sido
 * sustituida por…». «Esta tesis sustituye a…» está en la NUEVA y no cuenta.
 */
export function estadoCriterioDe(t: Pick<TesisSjf, "notaPublica" | "precedentes" | "texto">): EstadoCriterio {
  const notas = `${t.notaPublica ?? ""}\n${t.precedentes ?? ""}`;
  if (/se interrumpi[óo]|fue interrumpida|qued[óo] interrumpida|interrumpi[óo] la jurisprudencia/i.test(notas)) return "INTERRUMPIDA";
  if (/fue superada|qued[óo] superada|se abandon[óo] el criterio|criterio abandonado|superada por contradicci[óo]n/i.test(notas)) return "SUPERADA";
  if (/fue sustituida|ha sido sustituida|qued[óo] sustituida|sustituida por la diversa/i.test(notas)) return "SUSTITUIDA";
  return "VIGENTE";
}

/** Cita como la escribe un abogado: «Jurisprudencia 1a./J. 215/2025 (11a.), reg. 2031002». */
export function citaTesis(tipo: TipoCriterio, numero: string | null, registro: string): string {
  const etiqueta = tipo === "JURISPRUDENCIA" ? "Jurisprudencia" : "Tesis aislada";
  return numero ? `${etiqueta} ${numero.trim()}, reg. ${registro}` : `${etiqueta} reg. ${registro}`;
}

/** Tamaño objetivo de un chunk de tesis; las largas (10 k+ chars) se parten por párrafos. */
const CHUNK_MAX = 6000;
const PRECEDENTES_MAX = 1500;

function limpiar(s: string | null | undefined): string {
  return (s ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Chunks de una tesis: el rubro encabeza cada parte (es lo que la hace
 * encontrable), el texto se parte por párrafos si no cabe y los precedentes
 * van al final, recortados — sirven para citar, no para buscar.
 */
export function chunkTesis(t: Pick<TesisSjf, "rubro" | "texto" | "precedentes">, cita: string): { texto: string; parte: number | null }[] {
  const rubro = limpiar(t.rubro);
  const cuerpo = limpiar(t.texto);
  const prec = limpiar(t.precedentes);
  const precedentes = prec ? `\n\nPrecedentes: ${prec.length > PRECEDENTES_MAX ? prec.slice(0, PRECEDENTES_MAX) + " […]" : prec}` : "";
  const encabezado = `[${cita}]\n${rubro}\n\n`;
  const entero = `${encabezado}${cuerpo}${precedentes}`;
  if (entero.length <= CHUNK_MAX) return [{ texto: entero, parte: null }];

  const partes: string[] = [];
  let buf = "";
  for (const p of cuerpo.split(/\n\n+/)) {
    if (buf && buf.length + p.length + 2 > CHUNK_MAX - encabezado.length) {
      partes.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) partes.push(buf);
  return partes.map((texto, i) => ({
    texto: `${encabezado}${i > 0 ? "[… continúa]\n" : ""}${texto}${i === partes.length - 1 ? precedentes : ""}`,
    parte: i + 1,
  }));
}

/** JSON del API → lo que guarda la base. Puro. */
export function normalizarTesis(t: TesisSjf): TesisNormalizada {
  const registro = String(t.idTesis);
  const tipo = tipoCriterioDe(t.tipoTesis);
  const numero = t.tesis?.trim() || null;
  const cita = citaTesis(tipo, numero, registro);
  const { publicacion, obligatoria, respaldo } = fechasDe(t);
  const epoca = epocaCorta(t.epoca);
  const instancia = t.instancia?.trim() || null;
  const organo = t.organoJuris?.trim().replace(/\.$/, "") || null;
  return {
    clave: claveTesis(registro),
    registro,
    numeroTesis: numero,
    titulo: limpiar(t.rubro).slice(0, 1000),
    url: SJF_URL_DETALLE(registro),
    epoca,
    instancia,
    organo,
    tipoCriterio: tipo,
    estadoCriterio: estadoCriterioDe(t),
    fechaPublicacion: publicacion ?? respaldo,
    vigenciaDesde: obligatoria ?? publicacion ?? respaldo,
    hash: (t.huellaDigital ?? "").trim() || `sin-huella-${registro}`,
    materias: materiasDeTesis(t.materias, t.rubro ?? ""),
    contexto: [epoca ? `${epoca} Época` : null, instancia, organo].filter(Boolean).join(" · "),
    chunks: chunkTesis(t, cita),
  };
}
