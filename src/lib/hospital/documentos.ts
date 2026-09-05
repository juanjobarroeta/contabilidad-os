// ─────────────────────────────────────────────────────────────────────────────
// Documentos del expediente con contenido mínimo (NOM-004-SSA3-2012 §10 y
// RLGSMPSAM arts. 80-83): un consentimiento informado no es un «recibido /
// firmado», es un acto con el procedimiento autorizado, sus riesgos,
// beneficios y alternativas, quién firmó (paciente o representante y
// parentesco), dos testigos y el médico que informó con su cédula. Aquí
// viven las plantillas por tipo y las dos validaciones que las rutas aplican:
// `errorContenido` al capturar el JSON y `errorFirma` al marcar FIRMADO.
// Puro, sin Prisma: el satélite espeja PLANTILLAS_DOCUMENTO.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospDocumentoTipo } from "@prisma/client";

export const TIPOS_DOCUMENTO = [
  "CONSENTIMIENTO_CIRUGIA",
  "CONSENTIMIENTO_ANESTESIA",
  "CONSENTIMIENTO_TRANSFUSION",
  "CONSENTIMIENTO_HOSPITALIZACION",
  "IDENTIFICACION",
  "POLIZA",
  "CARTA_AUTORIZACION",
  "ESTUDIO",
  "RESULTADO",
  "RECETA",
  "REGISTRO_ANESTESICO",
  "HOJA_EGRESO",
  "NOTA_EGRESO",
  "AVISO_PRIVACIDAD",
  "OTRO",
] as const satisfies readonly HospDocumentoTipo[];

export const TIPOS_CONSENTIMIENTO: readonly HospDocumentoTipo[] = [
  "CONSENTIMIENTO_CIRUGIA",
  "CONSENTIMIENTO_ANESTESIA",
  "CONSENTIMIENTO_TRANSFUSION",
  "CONSENTIMIENTO_HOSPITALIZACION",
];

/** Qué firmas exige el documento para pasar a FIRMADO. */
export interface RequisitosFirma {
  /** Quien firma (paciente o representante legal). */
  firmante: boolean;
  /** Dos testigos (NOM-004 §10.1.1.3). */
  testigos: boolean;
  /** Médico que informa o elabora, con cédula. */
  medico: boolean;
}

export interface PlantillaDocumento {
  titulo: string;
  fundamento: string;
  obligatorias: readonly string[];
  opcionales: readonly string[];
  firma: RequisitosFirma;
}

const SIN_FIRMA: RequisitosFirma = { firmante: false, testigos: false, medico: false };

const consentimiento = (titulo: string, extra: readonly string[] = []): PlantillaDocumento => ({
  titulo,
  fundamento: "NOM-004-SSA3-2012 §10.1 · RLGSMPSAM arts. 80-83",
  obligatorias: ["procedimiento", "riesgos", "beneficios", "alternativas"],
  opcionales: ["establecimiento", "consecuenciasDeNoAceptar", "autorizaProcedimientosAdicionales", "observaciones", "lugarFechaHora", ...extra],
  firma: { firmante: true, testigos: true, medico: true },
});

export const PLANTILLAS_DOCUMENTO: Record<HospDocumentoTipo, PlantillaDocumento> = {
  CONSENTIMIENTO_CIRUGIA: consentimiento("Consentimiento informado para cirugía"),
  CONSENTIMIENTO_ANESTESIA: consentimiento("Consentimiento informado para anestesia", ["tipoAnestesia"]),
  CONSENTIMIENTO_TRANSFUSION: consentimiento("Consentimiento informado para transfusión", ["componentes"]),
  CONSENTIMIENTO_HOSPITALIZACION: consentimiento("Consentimiento de ingreso hospitalario"),
  REGISTRO_ANESTESICO: {
    titulo: "Registro anestésico",
    fundamento: "NOM-006-SSA3-2011 · NOM-004-SSA3-2012 §8.6",
    obligatorias: ["tecnica", "farmacos", "inicio", "fin", "incidentes"],
    opcionales: ["signosTransanestesicos", "liquidos", "sangrado", "anestesiologo", "viaAerea"],
    firma: { firmante: false, testigos: false, medico: true },
  },
  HOJA_EGRESO: {
    titulo: "Hoja de egreso con instrucciones",
    fundamento: "NOM-026-SSA3-2012 · NOM-004-SSA3-2012 §8.10",
    obligatorias: ["diagnostico", "instrucciones", "datosAlarma", "citaSeguimiento"],
    opcionales: ["medicamentos", "dieta", "actividad", "cuidadosHerida", "contactoUrgencias"],
    firma: { firmante: true, testigos: false, medico: true },
  },
  AVISO_PRIVACIDAD: {
    titulo: "Aviso de privacidad (constancia de aceptación)",
    fundamento: "LFPDPPP 2025 arts. 7-11",
    obligatorias: ["version"],
    opcionales: ["url", "finalidades", "transferencias", "medioDeAceptacion"],
    firma: { firmante: true, testigos: false, medico: false },
  },
  IDENTIFICACION: { titulo: "Identificación oficial", fundamento: "NOM-004-SSA3-2012 §5.2", obligatorias: [], opcionales: ["tipo", "numero", "vigencia"], firma: SIN_FIRMA },
  POLIZA: { titulo: "Póliza / carnet de asegurado", fundamento: "Convenio con el pagador", obligatorias: [], opcionales: ["aseguradora", "poliza", "vigencia"], firma: SIN_FIRMA },
  CARTA_AUTORIZACION: { titulo: "Carta de autorización del pagador", fundamento: "Convenio con el pagador", obligatorias: [], opcionales: ["folio", "monto", "vigencia"], firma: SIN_FIRMA },
  ESTUDIO: { titulo: "Solicitud de estudio", fundamento: "NOM-004-SSA3-2012 §9.2", obligatorias: [], opcionales: ["estudio", "indicacion"], firma: SIN_FIRMA },
  RESULTADO: { titulo: "Resultado de estudio", fundamento: "NOM-004-SSA3-2012 §9.2", obligatorias: [], opcionales: ["estudio", "resultado", "laboratorio"], firma: SIN_FIRMA },
  RECETA: { titulo: "Receta", fundamento: "Reglamento de Insumos para la Salud arts. 28-31", obligatorias: [], opcionales: ["folio", "medicamentos", "prescriptor", "cedula"], firma: SIN_FIRMA },
  NOTA_EGRESO: { titulo: "Nota de egreso (documento)", fundamento: "NOM-004-SSA3-2012 §8.10", obligatorias: [], opcionales: [], firma: { firmante: false, testigos: false, medico: true } },
  OTRO: { titulo: "Otro documento", fundamento: "—", obligatorias: [], opcionales: [], firma: SIN_FIRMA },
};

/** Etiquetas en español de las secciones de `contenido`, para el satélite. */
export const ETIQUETA_CONTENIDO: Record<string, string> = {
  procedimiento: "Acto médico o procedimiento autorizado",
  riesgos: "Riesgos y complicaciones posibles",
  beneficios: "Beneficios esperados",
  alternativas: "Alternativas de tratamiento",
  establecimiento: "Nombre del establecimiento",
  consecuenciasDeNoAceptar: "Consecuencias de no aceptar",
  autorizaProcedimientosAdicionales: "Autoriza procedimientos adicionales necesarios",
  observaciones: "Observaciones",
  lugarFechaHora: "Lugar, fecha y hora",
  tipoAnestesia: "Tipo de anestesia",
  componentes: "Componentes sanguíneos",
  tecnica: "Técnica anestésica",
  farmacos: "Fármacos con dosis y hora",
  inicio: "Inicio",
  fin: "Fin",
  incidentes: "Incidentes y accidentes",
  signosTransanestesicos: "Signos transanestésicos",
  liquidos: "Líquidos y sangre",
  sangrado: "Sangrado",
  anestesiologo: "Anestesiólogo",
  viaAerea: "Vía aérea",
  diagnostico: "Diagnóstico",
  instrucciones: "Instrucciones de cuidado en casa",
  datosAlarma: "Datos de alarma (cuándo regresar)",
  citaSeguimiento: "Cita de seguimiento",
  medicamentos: "Medicamentos (dosis y horario)",
  dieta: "Dieta",
  actividad: "Actividad física",
  cuidadosHerida: "Cuidados de la herida",
  contactoUrgencias: "Teléfono de urgencias",
  version: "Versión del aviso",
  url: "URL del aviso integral",
  finalidades: "Finalidades del tratamiento",
  transferencias: "Transferencias (aseguradoras, médicos externos)",
  medioDeAceptacion: "Medio de aceptación",
  tipo: "Tipo de identificación",
  numero: "Número",
  vigencia: "Vigencia",
  aseguradora: "Aseguradora",
  poliza: "Número de póliza",
  folio: "Folio",
  monto: "Monto autorizado",
  estudio: "Estudio",
  indicacion: "Indicación",
  resultado: "Resultado",
  laboratorio: "Laboratorio / gabinete",
  prescriptor: "Médico prescriptor",
  cedula: "Cédula del prescriptor",
};

const MAX_CLAVES = 60;
const MAX_TEXTO = 20_000;
const CLAVE_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,60}$/;

function vacio(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim().length === 0;
  if (typeof v === "number") return !Number.isFinite(v);
  if (typeof v === "boolean") return false;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return true;
}

/**
 * Valida `contenido` contra la plantilla del tipo. `exigirObligatorias` es
 * false mientras el documento está PENDIENTE (se puede registrar y llenar
 * después) y true al marcarlo FIRMADO. Devuelve el motivo o null.
 */
export function errorContenido(tipo: HospDocumentoTipo, contenido: unknown, exigirObligatorias: boolean): string | null {
  const plantilla = PLANTILLAS_DOCUMENTO[tipo];
  if (!plantilla) return `Tipo de documento desconocido: ${tipo}`;
  if (contenido == null) {
    if (!exigirObligatorias || !plantilla.obligatorias.length) return null;
    return `${plantilla.titulo} requiere el contenido: ${plantilla.obligatorias.map((s) => ETIQUETA_CONTENIDO[s] ?? s).join(", ")} (${plantilla.fundamento})`;
  }
  if (typeof contenido !== "object" || Array.isArray(contenido)) return "contenido debe ser un objeto { seccion: contenido }";
  const obj = contenido as Record<string, unknown>;
  const claves = Object.keys(obj);
  if (claves.length > MAX_CLAVES) return `Demasiadas secciones en contenido (máximo ${MAX_CLAVES})`;
  for (const k of claves) {
    if (!CLAVE_RE.test(k)) return `Nombre de sección inválido en contenido: «${k}»`;
    const v = obj[k];
    if (typeof v === "string" && v.length > MAX_TEXTO) return `La sección ${k} excede ${MAX_TEXTO} caracteres`;
    if (typeof v === "function" || typeof v === "symbol") return `La sección ${k} no es serializable`;
  }
  if (!exigirObligatorias) return null;
  const faltan = plantilla.obligatorias.filter((s) => vacio(obj[s]));
  if (faltan.length) {
    return `A ${plantilla.titulo.toLowerCase()} le falta: ${faltan.map((s) => ETIQUETA_CONTENIDO[s] ?? s).join(", ")} (${plantilla.fundamento})`;
  }
  return null;
}

export interface DocumentoFirmable {
  tipo: HospDocumentoTipo;
  contenido?: unknown;
  firmadoPor?: string | null;
  firmadoParentesco?: string | null;
  testigo1?: string | null;
  testigo2?: string | null;
  medicoNombre?: string | null;
  medicoCedula?: string | null;
}

/** Qué le falta al documento para poder marcarse FIRMADO; null si puede. */
export function errorFirma(doc: DocumentoFirmable): string | null {
  const plantilla = PLANTILLAS_DOCUMENTO[doc.tipo];
  if (!plantilla) return `Tipo de documento desconocido: ${doc.tipo}`;
  const contenido = errorContenido(doc.tipo, doc.contenido, true);
  if (contenido) return contenido;
  const faltan: string[] = [];
  if (plantilla.firma.firmante && !doc.firmadoPor?.trim()) faltan.push("quién firma (firmadoPor: paciente o representante)");
  if (plantilla.firma.testigos && (!doc.testigo1?.trim() || !doc.testigo2?.trim())) faltan.push("dos testigos (testigo1 y testigo2)");
  if (plantilla.firma.medico && (!doc.medicoNombre?.trim() || !doc.medicoCedula?.trim())) faltan.push("médico que informa con su cédula (medicoNombre y medicoCedula)");
  if (!faltan.length) return null;
  return `${plantilla.titulo} no se puede marcar FIRMADO sin ${faltan.join(", ")} (${plantilla.fundamento})`;
}

/** Los campos de contenido/firma que quedan congelados una vez FIRMADO. */
export const CAMPOS_CONGELADOS_AL_FIRMAR = ["contenido", "firmadoPor", "firmadoParentesco", "testigo1", "testigo2", "medicoNombre", "medicoCedula"] as const;
