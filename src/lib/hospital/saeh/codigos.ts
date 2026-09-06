// ─────────────────────────────────────────────────────────────────────────────
// SAEH — códigos de la DGIS (GIIS-B002-05-09 v5.9, egresos hospitalarios).
//
// Las tablas chicas del diccionario de datos con su etiqueta en español, los
// puentes desde nuestros enums (motivo de egreso, sexo, tipo de episodio) y
// los rangos de la CIE-10 que disparan reglas (aborto, parto, causa externa,
// obstétrico). Sin Prisma ni base: lo que consulta catálogos vive en
// catalogo.ts; aquí sólo constantes y funciones puras.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospEpisodioTipo, HospMotivoEgreso, HospSexo } from "@prisma/client";
import { diasEntre, partesLocales } from "../tz";

/** CURP genérica que admite la DGIS cuando no se cuenta con la del paciente (o del médico extranjero). */
export const CURP_GENERICA = "XXXX999999XXXXXX99";

/** Fecha de nacimiento desconocida (sólo con CURP genérica). */
export const FECHA_DESCONOCIDA = "09/09/9999";

/** País de nacimiento/residencia México en el catálogo PAIS de la DGIS. */
export const PAIS_MEXICO = "142";
export const PAIS_NO_ESPECIFICADO = "248";

export type Etiquetas = Readonly<Record<string, string>>;

export const MOTIVO_EGRESO: Etiquetas = {
  "1": "Curación",
  "2": "Mejoría",
  "3": "Voluntad propia",
  "4": "Traslado a otra unidad",
  "5": "Defunción",
  "6": "Fuga",
  "7": "Otro",
};

export const PROCEDENCIA: Etiquetas = {
  "1": "Consulta externa",
  "2": "Urgencias",
  "3": "Referido",
  "4": "Cunero patológico",
  "5": "Otro",
};

export const TIPO_SERVICIO_INGRESO: Etiquetas = { "1": "Normal", "2": "Corta estancia" };

export const TIPO_ATENCION: Etiquetas = { "1": "Primera vez", "2": "Subsecuente" };

export const TIPO_ANESTESIA: Etiquetas = {
  "1": "General",
  "2": "Regional",
  "3": "Sedación",
  "4": "Local",
  "5": "Combinada",
  "6": "No usó",
};

export const QUIROFANO: Etiquetas = { "1": "Dentro", "2": "Fuera" };

export const SI_NO: Etiquetas = { "1": "Sí", "2": "No", "8": "No aplica" };

export const SI_NO_PREFIERE: Etiquetas = { "1": "Sí", "2": "No", "3": "Prefiere no responder", "8": "No aplica" };

export const ESTADO_CONYUGAL: Etiquetas = {
  "0": "No especificado",
  "1": "Soltero(a)",
  "2": "Viudo(a)",
  "3": "Divorciado(a)",
  "4": "Unión libre",
  "5": "Casado(a)",
  "6": "Separado(a)",
  "8": "No aplica (menor de 10 años)",
  "9": "Se ignora",
};

export const GENERO: Etiquetas = {
  "-1": "No aplica",
  "1": "Mujer trans",
  "2": "Hombre trans",
  "3": "Persona no binaria",
  "4": "Lesbiana",
  "5": "Gay",
  "6": "Bisexual",
};

export const MUJER_FERTIL: Etiquetas = {
  "-1": "No aplica",
  "1": "Embarazo",
  "2": "Puerperio (0 a 42 días después del evento obstétrico)",
  "3": "No estaba embarazada ni en el puerperio",
};

export const SEXO: Etiquetas = { "1": "Hombre", "2": "Mujer", "3": "Intersexual" };

export const SEXO_CURP: Etiquetas = { "0": "No especificado (CURP genérica)", "1": "Hombre", "2": "Mujer", "3": "No binario" };

export const TIPO_EDAD: Etiquetas = { "2": "Horas", "3": "Días", "4": "Meses", "5": "Años" };

export const EXTRACCION_EXPULSION: Etiquetas = { "-1": "No aplica", "1": "Sí", "2": "No" };

export const TIPO_ATENCION_OBSTETRICA: Etiquetas = { "-1": "No aplica", "1": "Aborto", "2": "Parto" };

export const TIPO_PARTO: Etiquetas = { "-1": "No aplica", "1": "Eutócico", "2": "Distócico vaginal", "3": "Cesárea", "9": "No especificado" };

export const TIPO_PROC_ABORTO: Etiquetas = {
  "-1": "No aplica",
  "1": "LUI",
  "2": "AMEU",
  "3": "Medicamento",
  "4": "DyE",
  "5": "Laparotomía exploratoria",
  "6": "Quirúrgico no especificado",
  "9": "No especificado",
};

export const PRODUCTO_EMBARAZO: Etiquetas = { "-1": "No aplica", "1": "Único", "2": "Gemelar", "3": "Tres o más" };

export const PLANIFICACION_FAMILIAR: Etiquetas = {
  "-1": "No aplica",
  "0": "Ninguno",
  "1": "Hormonal oral",
  "2": "Inyectable mensual",
  "3": "Inyectable bimestral",
  "4": "Implante subdérmico una varilla",
  "5": "DIU",
  "6": "Preservativo femenino",
  "7": "Preservativo masculino",
  "8": "DIU medicado",
  "9": "Parche dérmico",
  "10": "OTB",
  "11": "Otro método",
  "12": "Inyectable trimestral",
  "13": "Implante subdérmico doble varilla",
};

export const CONDICION_NACIMIENTO: Etiquetas = { "1": "Muerte fetal", "2": "Nacido vivo" };

export const CONDICION_NACIDO_VIVO: Etiquetas = { "1": "Vivo, alta", "2": "Vivo, hospitalizado", "3": "Muerto" };

export const TIPO_UNIDAD_PSIQ: Etiquetas = { "-1": "No aplica", "1": "Hospital continuo", "2": "Hospital parcial", "3": "Unidad de cuidados especiales" };

export const TIPO_SERVICIO_PSIQ_CONTINUO: Etiquetas = {
  "1": "Paidopsiquiatría",
  "2": "Psiquiatría",
  "3": "Psicogeriatría",
  "4": "Unidad de desintoxicación",
  "5": "Villa psiquiátrica",
  "8": "Otros",
  "9": "No especificado",
};

export const TIPO_SERVICIO_PSIQ_PARCIAL: Etiquetas = { "1": "Día", "2": "Noche", "3": "Fin de semana", "4": "Otros", "9": "No especificado" };

export const MINISTERIO_PUBLICO: Etiquetas = { "-1": "No aplica", "1": "Sí", "2": "No" };

/** Opciones de derechohabiencia que admite la GIIS v5.9 (el catálogo AFILIACION trae más, p. ej. 10 y 13, que la guía ya no acepta). */
export const DERECHOHABIENCIA_GIIS: Etiquetas = {
  "0": "No especificado",
  "1": "Ninguna",
  "2": "IMSS",
  "3": "ISSSTE",
  "4": "PEMEX",
  "5": "SEDENA",
  "6": "SEMAR",
  "8": "Otra",
  "11": "ISSFAM",
  "14": "OPD IMSS Bienestar",
  "99": "Se ignora",
};

/** Todas las tablas chicas, para que el satélite pinte etiquetas sin copiarlas. */
export const CODIGOS_SAEH = {
  motivoEgreso: MOTIVO_EGRESO,
  procedencia: PROCEDENCIA,
  tipoServicioIngreso: TIPO_SERVICIO_INGRESO,
  tipoAtencion: TIPO_ATENCION,
  tipoAnestesia: TIPO_ANESTESIA,
  quirofano: QUIROFANO,
  siNo: SI_NO,
  siNoPrefiere: SI_NO_PREFIERE,
  estadoConyugal: ESTADO_CONYUGAL,
  genero: GENERO,
  mujerFertil: MUJER_FERTIL,
  sexo: SEXO,
  sexoCurp: SEXO_CURP,
  tipoEdad: TIPO_EDAD,
  extraccionExpulsion: EXTRACCION_EXPULSION,
  tipoAtencionObstetrica: TIPO_ATENCION_OBSTETRICA,
  tipoParto: TIPO_PARTO,
  tipoProcAborto: TIPO_PROC_ABORTO,
  productoEmbarazo: PRODUCTO_EMBARAZO,
  planificacionFamiliar: PLANIFICACION_FAMILIAR,
  condicionNacimiento: CONDICION_NACIMIENTO,
  condicionNacidoVivo: CONDICION_NACIDO_VIVO,
  tipoUnidadPsiq: TIPO_UNIDAD_PSIQ,
  tipoServicioPsiqContinuo: TIPO_SERVICIO_PSIQ_CONTINUO,
  tipoServicioPsiqParcial: TIPO_SERVICIO_PSIQ_PARCIAL,
  ministerioPublico: MINISTERIO_PUBLICO,
  derechohabiencia: DERECHOHABIENCIA_GIIS,
} as const;

// ── Puentes desde nuestros enums ─────────────────────────────────────────────

/** HospMotivoEgreso → motivoEgreso de la GIIS (1-7). */
export const MOTIVO_EGRESO_SAEH: Record<HospMotivoEgreso, number> = {
  CURACION: 1,
  MEJORIA: 2,
  VOLUNTARIA: 3,
  TRASLADO: 4,
  DEFUNCION: 5,
  FUGA: 6,
  OTRO: 7,
};

/** HospSexo → sexo de la GIIS (1 hombre, 2 mujer, 3 intersexual). */
export const SEXO_SAEH: Record<HospSexo, number> = { MASCULINO: 1, FEMENINO: 2, OTRO: 3 };

/** Posición 11 de la CURP → sexoCURP (H 1, M 2, X 3); genérica → 0; otra cosa → null. */
export function sexoCurpDe(curp: string | null | undefined): number | null {
  const c = (curp ?? "").trim().toUpperCase();
  if (!c) return null;
  if (c === CURP_GENERICA) return 0;
  const letra = c[10];
  return letra === "H" ? 1 : letra === "M" ? 2 : letra === "X" ? 3 : null;
}

/** Abreviatura de entidad en la CURP (posiciones 12-13) → clave INEGI de dos dígitos. NE (extranjero) no está. */
export const ENTIDAD_POR_ABREVIATURA: Readonly<Record<string, string>> = {
  AS: "01", BC: "02", BS: "03", CC: "04", CL: "05", CM: "06", CS: "07", CH: "08", DF: "09", DG: "10",
  GT: "11", GR: "12", HG: "13", JC: "14", MC: "15", MN: "16", MS: "17", NT: "18", NL: "19", OC: "20",
  PL: "21", QT: "22", QR: "23", SP: "24", SL: "25", SR: "26", TC: "27", TS: "28", TL: "29", VZ: "30",
  YN: "31", ZS: "32",
};

/** Entidad de nacimiento según la CURP: clave INEGI, "NE" si nació en el extranjero, null si la CURP no lo dice. */
export function entidadDeCurp(curp: string | null | undefined): string | "NE" | null {
  const c = (curp ?? "").trim().toUpperCase();
  if (c.length !== 18 || c === CURP_GENERICA) return null;
  const abrev = c.slice(11, 13);
  if (abrev === "NE") return "NE";
  return ENTIDAD_POR_ABREVIATURA[abrev] ?? null;
}

/** Procedencia por default según el tipo de episodio (la hoja puede corregirla). */
export function procedenciaPorTipo(tipo: HospEpisodioTipo): number {
  if (tipo === "URGENCIAS") return 2;
  if (tipo === "CONSULTA") return 1;
  return 5;
}

/** tipoServicioIngreso: 2 corta estancia para AMBULATORIO (clave "-1"), 1 normal para el resto. */
export function tipoServicioPorTipo(tipo: HospEpisodioTipo): { tipoServicioIngreso: number; claveServicioIngreso: string | null } {
  return tipo === "AMBULATORIO" ? { tipoServicioIngreso: 2, claveServicioIngreso: "-1" } : { tipoServicioIngreso: 1, claveServicioIngreso: null };
}

// ── Servicios (SERVICIOS_ESPECIALIDADES) con regla de edad/sexo ──────────────

export const SERVICIOS_TERAPIA_INTENSIVA = ["602", "603", "604", "605", "701"] as const;
export const SERVICIOS_TERAPIA_INTERMEDIA = ["606", "703"] as const;
/** ID_ESPECIALIDAD 3 (301-341) más 604, 605 y 902: paciente menor de 18 años. */
export const SERVICIOS_PEDIATRICOS_EXTRA = ["604", "605", "902"] as const;
/** Menor o igual a 28 días. */
export const SERVICIOS_NEONATALES = ["333", "338", "701", "703"] as const;
/** ID_ESPECIALIDAD 4 (401-406): mujer de 9 a 59 años, salvo 402 y 406. */
export const SERVICIOS_GINECO_SIN_EDAD = ["402", "406"] as const;
export const SERVICIO_GERIATRIA = "108";

export function esServicioPediatrico(clave: string): boolean {
  return /^3\d\d$/.test(clave) || (SERVICIOS_PEDIATRICOS_EXTRA as readonly string[]).includes(clave);
}
export function esServicioGineco(clave: string): boolean {
  return /^4\d\d$/.test(clave);
}

// ── Rangos de la CIE-10 que disparan reglas ───────────────────────────────────

/** Categoría (3 caracteres) de una clave DGIS («O150» → «O15»). */
export const categoriaCie = (clave: string) => clave.slice(0, 3).toUpperCase();

function enRango(clave: string, desde: string, hasta: string): boolean {
  const cat = categoriaCie(clave);
  return cat >= desde && cat <= hasta && cat[0] >= desde[0] && cat[0] <= hasta[0];
}

/** Capítulo XX, causas externas (V01-Y98). */
export const esCausaExterna = (clave: string) => /^[VWXY]/.test(clave.toUpperCase());
/** Capítulo XIX, traumatismos y envenenamientos (S00-T98). */
export const esTraumatismo = (clave: string) => /^[ST]/.test(clave.toUpperCase());
/** Capítulo V, trastornos mentales (F00-F99). */
export const esTrastornoMental = (clave: string) => /^F/.test(clave.toUpperCase());
/** Capítulo II, tumores (C00-D48). */
export const esTumor = (clave: string) => enRango(clave, "C00", "C97") || enRango(clave, "D00", "D48");
/** Aborto (O00-O08). */
export const esAborto = (clave: string) => enRango(clave, "O00", "O08");
/** Parto (O80-O84). */
export const esParto = (clave: string) => enRango(clave, "O80", "O84");
/** Bloque obstétrico: O00-O08, O10-O26, O29-O84, O85-O92, O98-O99. */
export const esObstetrico = (clave: string) =>
  enRango(clave, "O00", "O08") || enRango(clave, "O10", "O26") || enRango(clave, "O29", "O84") || enRango(clave, "O85", "O92") || enRango(clave, "O98", "O99");

/** Códigos con los que la causa externa y el folio de lesión son OPCIONALES (Cap. V, O04-O07, O20, O267, O429, O468-O469, O68, O710, O713-O719). */
export function causaExternaOpcional(clave: string): boolean {
  const c = clave.toUpperCase();
  if (esTrastornoMental(c)) return true;
  if (enRango(c, "O04", "O07") || categoriaCie(c) === "O20" || categoriaCie(c) === "O68") return true;
  if (c === "O267" || c === "O429" || c === "O468" || c === "O469" || c === "O710") return true;
  return /^O71[3-9]/.test(c);
}

/** Capítulos que NO cuentan como «otra comorbilidad» en la regla Z303/O04 (XVIII, XIX, XXI salvo Z55-Z65, XXII). */
export function esComorbilidadSustantiva(clave: string): boolean {
  const c = clave.toUpperCase();
  if (/^R/.test(c)) return false; // XVIII
  if (esTraumatismo(c)) return false; // XIX
  if (/^U/.test(c)) return false; // XXII
  if (/^Z/.test(c)) return enRango(c, "Z55", "Z65"); // XXI salvo Z55-Z65
  return true;
}

/**
 * Códigos de 4 caracteres que el catálogo DIAGNOSTICO de la DGIS marca con
 * AF_PRIN = NO fuera del capítulo XX (agentes B95-B98, muertes I46/O95-O97/
 * P95/R95-R99, T76, códigos U de uso emergente y resistencia, Z00-Z02 y Z37).
 * El capítulo XX completo tampoco vale como afección principal.
 */
export const NO_AFECCION_PRINCIPAL: ReadonlySet<string> = new Set(
  (
    "B950,B951,B952,B953,B954,B955,B956,B957,B958,B960,B961,B962,B963,B964,B965,B966,B967,B968,B970,B971,B972,B973,B974,B975,B976,B977,B978,B980,B981," +
    "I461,I469,O95X,O960,O961,O969,O96X,O970,O971,O979,O97X,P95X,R950,R959,R95X,R960,R961,R98X,R99X,T76X," +
    "U060,U061,U062,U063,U064,U065,U066,U067,U068,U073,U074,U075,U076,U077,U078,U079,U089," +
    "U800,U801,U808,U810,U818,U820,U821,U822,U828,U829,U830,U831,U832,U837,U838,U839,U840,U841,U842,U843,U847,U848,U849,U85X,U898,U899,U92X," +
    "U930,U931,U932,U933,U934,U935,U936,U938,U939,U95X,U96X,U97X,U98X,U99X," +
    "Z000,Z001,Z002,Z003,Z004,Z005,Z006,Z008,Z010,Z011,Z012,Z013,Z014,Z015,Z016,Z017,Z018,Z019," +
    "Z020,Z021,Z022,Z023,Z024,Z025,Z026,Z027,Z028,Z029,Z370,Z371,Z372,Z373,Z374,Z375,Z376,Z377,Z379"
  ).split(",")
);

export function validaComoAfeccionPrincipal(clave: string): boolean {
  const c = clave.toUpperCase();
  return !esCausaExterna(c) && !NO_AFECCION_PRINCIPAL.has(c);
}

// ── CIE-9-MC: grupos que disparan reglas ──────────────────────────────────────

/** Cesárea: grupos 740-744 y 749. */
export const esCesareaCie9 = (clave: string) => /^74[0-4]/.test(clave) || /^749/.test(clave);
/** Esterilización masculina (637). */
export const esEsterilizacionHombre = (clave: string) => /^637/.test(clave);
/** Esterilización femenina (662, 663, 665, 6663). */
export const esEsterilizacionMujer = (clave: string) => /^66[235]/.test(clave) || clave === "6663";
/** OTB para planificación familiar (662, 663, 665 o 6663). */
export const esOtbCie9 = esEsterilizacionMujer;
/** Histerectomía (683-687, 689). */
export const esHisterectomia = (clave: string) => /^68[3-7]/.test(clave) || /^689/.test(clave);
export const DIU_CIE9 = "697X";

// ── CLUES: tipologías con reglas propias ─────────────────────────────────────

/** Unidades psiquiátricas (CLAVE DE TIPOLOGIA «Y» —con subtipología 99/NES/INP/SAP—, «HPSIQ» o «HPSIQMF»). */
export const TIPOLOGIAS_PSIQUIATRICAS: readonly string[] = ["Y", "HPSIQ", "HPSIQMF"];
/** Consulta externa (tipo 1) que sí puede reportar egresos. */
export const TIPOLOGIAS_CONSULTA_EXTERNA_CON_EGRESOS: readonly string[] = ["CAP", "CES", "CLI", "T", "UNE", "Z"];
export const CLUES_TIPO_HOSPITALIZACION = "2";
export const CLUES_TIPO_CONSULTA_EXTERNA = "1";
export const CLUES_ESTATUS_EN_OPERACION = "1";

// ── Palabras inválidas en «especifique» (SEUL, 23-mar-2026) ──────────────────

export const PALABRAS_INVALIDAS_PROCEDENCIA: readonly string[] = [
  "CONSULTA EXTERNA", "CONSULTA", "URGENCIAS", "URGENCIA", "REFERIDO", "CUNERO PATOLOGICO", "CUNEROS PATOLOGICOS", "CUNERO", "CUNEROS",
  "OTRO", "OTROS", "OTRA", "OTRAS",
];

export const PALABRAS_INVALIDAS_OTRO_METODO: readonly string[] = [
  "NINGUNO", "HORMONAL ORAL", "HORMONAL", "ORAL", "INYECTABLE MENSUAL", "INYECTABLE BIMESTRAL", "INYECTABLE", "IMPLANTE SUBDERMICO", "IMPLANTE",
  "SUBDERMICO", "DIU", "PRESERVATIVO FEMENINO", "PRESERVATIVO MASCULINO", "PRESERVATIVO", "DIU MEDICADO", "PARCHE DERMICO", "PARCHE", "DERMICO",
  "OTB", "OCLUSION TUBARICA BILATERAL", "OCLUSION", "OCLUSION TUBARICA", "TUBARICA BILATERAL", "OTRO METODO", "OTRO", "METODO",
];

// ── Edad como la cuenta la DGIS ──────────────────────────────────────────────

export interface EdadSaeh {
  /** 2 horas · 3 días · 4 meses · 5 años (catálogo TIPO_EDAD). */
  tipo: 2 | 3 | 4 | 5;
  valor: number;
  /** Años cumplidos en la fecha de referencia (0 en menores de un año). */
  anios: number;
  /** Días de vida en la fecha de referencia: lo que acotan LINF/LSUP de la CIE. */
  dias: number;
  /** Fecha contra la que se calculó: el egreso, o el ingreso si tenía menos de un año. */
  referencia: Date;
  texto: string;
}

function aniosCumplidos(nacimiento: Date, ref: Date): number {
  const n = partesLocales(nacimiento);
  const r = partesLocales(ref);
  let anios = r.y - n.y;
  if (r.m < n.m || (r.m === n.m && r.d < n.d)) anios--;
  return Math.max(0, anios);
}

function mesesCumplidos(nacimiento: Date, ref: Date): number {
  const n = partesLocales(nacimiento);
  const r = partesLocales(ref);
  let meses = (r.y - n.y) * 12 + (r.m - n.m);
  if (r.d < n.d) meses--;
  return Math.max(0, meses);
}

/**
 * Edad al egreso; si es menor de un año, al ingreso (GIIS, variable 7). Horas
 * en menores de un día, días en menores de 30 días, meses en menores de un
 * año, años en adelante (instructivo SINBA-SEUL-14-P).
 */
export function calcularEdadSaeh(nacimiento: Date, ingreso: Date, egreso: Date): EdadSaeh {
  const aniosEgreso = aniosCumplidos(nacimiento, egreso);
  if (aniosEgreso >= 1) {
    return { tipo: 5, valor: aniosEgreso, anios: aniosEgreso, dias: Math.max(0, diasEntre(nacimiento, egreso)), referencia: egreso, texto: `${aniosEgreso} ${aniosEgreso === 1 ? "año" : "años"}` };
  }
  const ref = ingreso;
  const dias = Math.max(0, diasEntre(nacimiento, ref));
  if (dias < 1) {
    const horas = Math.max(0, Math.min(23, Math.floor((ref.getTime() - nacimiento.getTime()) / 3_600_000)));
    return { tipo: 2, valor: horas, anios: 0, dias: 0, referencia: ref, texto: `${horas} ${horas === 1 ? "hora" : "horas"}` };
  }
  if (dias < 30) return { tipo: 3, valor: dias, anios: 0, dias, referencia: ref, texto: `${dias} ${dias === 1 ? "día" : "días"}` };
  const meses = Math.max(1, mesesCumplidos(nacimiento, ref));
  return { tipo: 4, valor: meses, anios: 0, dias, referencia: ref, texto: `${meses} ${meses === 1 ? "mes" : "meses"}` };
}

/** Meses cumplidos totales (para «≤ 3 meses» de nacioHospital). */
export function mesesDeEdad(edad: EdadSaeh): number {
  if (edad.tipo === 5) return edad.anios * 12 + 12; // ≥ 12 meses, basta para las reglas
  if (edad.tipo === 4) return edad.valor;
  return 0;
}

// ── Anestesia: del texto de la nota preanestésica al código ──────────────────

/** «General balanceada» → 1, «Bloqueo peridural» → 2, «Sedación» → 3, «Local» → 4, «Mixta» → 5, «Sin anestesia» → 6; null si no se reconoce. */
export function tipoAnestesiaDeTexto(texto: string | null | undefined): number | null {
  if (!texto) return null;
  const t = texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
  if (/\b(SIN ANESTESIA|NO (SE )?US[OÓ]|NINGUNA)\b/.test(t)) return 6;
  if (/\b(COMBINADA|MIXTA)\b/.test(t)) return 5;
  if (/\bGENERAL\b/.test(t)) return 1;
  if (/\b(REGIONAL|BLOQUEO|PERIDURAL|EPIDURAL|RAQUIA|RAQUIDEA|ESPINAL|SUBARACNOIDEA|PLEXO|TRONCULAR|NEUROAXIAL)\b/.test(t)) return 2;
  if (/\bSEDACION\b/.test(t)) return 3;
  if (/\bLOCAL\b/.test(t)) return 4;
  return null;
}
