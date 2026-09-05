// ─────────────────────────────────────────────────────────────────────────────
// Notas del expediente (NOM-004-SSA3-2012) con contenido mínimo y firma del
// sistema (NOM-024-SSA3-2012).
//
// Cada tipo de nota tiene una PLANTILLA: las secciones que la norma exige y
// las que conviene capturar. `secciones` viaja como JSON { seccion: contenido }
// y el hub la valida contra la plantilla antes de guardar; el texto libre
// (`texto`) sigue existiendo como resumen/observaciones. Las notas médicas las
// firma un médico con cédula (HospMedico.cedula o `autorCedula`); las de
// enfermería y las que genera el sistema (medicamento aplicado) no la exigen.
//
// Firma del sistema: SHA-256 del contenido canónico (episodio, tipo, fecha,
// texto, secciones, autor, cédula, médico, nota reemplazada) y sello de
// tiempo al crear. La nota es inmutable; `verificarHashNota` detecta cualquier
// alteración posterior en la base. La e.firma llega en v2.
//
// Sin imports del hub (`@/…`): el seed y los scripts la cargan con ts-node.
// El satélite espeja PLANTILLAS_NOTA y ETIQUETA_SECCION (docs/HOSPITAL.md).
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import type { HospNotaTipo, Prisma, PrismaClient } from "@prisma/client";
import { HospitalError } from "./errores";

type Db = PrismaClient | Prisma.TransactionClient;

export const TIPOS_NOTA = [
  "HISTORIA_CLINICA",
  "INGRESO",
  "EVOLUCION",
  "PREOPERATORIA",
  "PREANESTESICA",
  "POSTOPERATORIA",
  "POSTANESTESICA",
  "ENFERMERIA",
  "HOJA_URGENCIAS",
  "INDICACION",
  "INTERCONSULTA",
  "REFERENCIA",
  "PROCEDIMIENTO",
  "MEDICAMENTO_APLICADO",
  "EGRESO",
] as const satisfies readonly HospNotaTipo[];

export interface PlantillaNota {
  titulo: string;
  /** Numeral de la NOM-004 (u otra norma) que pide ese contenido. */
  fundamento: string;
  /** La firma un médico: exige cédula (medicoId con cédula o autorCedula). */
  medica: boolean;
  obligatorias: readonly string[];
  opcionales: readonly string[];
}

export const PLANTILLAS_NOTA: Record<HospNotaTipo, PlantillaNota> = {
  HISTORIA_CLINICA: {
    titulo: "Historia clínica",
    fundamento: "NOM-004-SSA3-2012 §6.1",
    medica: true,
    obligatorias: [
      "antecedentesHeredofamiliares",
      "antecedentesPersonalesPatologicos",
      "antecedentesPersonalesNoPatologicos",
      "padecimientoActual",
      "exploracionFisica",
      "diagnosticos",
      "pronostico",
      "plan",
    ],
    opcionales: ["antecedentesGinecoObstetricos", "interrogatorioAparatosSistemas", "estudiosPrevios", "signosVitales"],
  },
  INGRESO: {
    titulo: "Nota de ingreso",
    fundamento: "NOM-004-SSA3-2012 §8.1",
    medica: true,
    obligatorias: ["signosVitales", "resumenInterrogatorio", "exploracionFisica", "diagnosticos", "pronostico", "plan"],
    opcionales: ["estudios", "tratamiento"],
  },
  EVOLUCION: {
    titulo: "Nota de evolución",
    fundamento: "NOM-004-SSA3-2012 §8.2",
    medica: true,
    obligatorias: ["subjetivo", "objetivo", "analisis", "plan"],
    opcionales: ["signosVitales", "estudios", "diagnosticos", "pronostico"],
  },
  PREOPERATORIA: {
    titulo: "Nota preoperatoria",
    fundamento: "NOM-004-SSA3-2012 §8.4",
    medica: true,
    obligatorias: ["diagnostico", "planQuirurgico", "tipoIntervencion", "riesgoQuirurgico", "pronostico"],
    opcionales: ["fechaCirugia", "cuidadosPreoperatorios", "estudios"],
  },
  PREANESTESICA: {
    titulo: "Nota preanestésica",
    fundamento: "NOM-004-SSA3-2012 §8.5 · NOM-006-SSA3-2011 · NOM-026-SSA3-2012",
    medica: true,
    obligatorias: ["evaluacionClinica", "asa", "tipoAnestesia", "planAnestesico"],
    opcionales: ["medicacionPreanestesica", "viaAerea", "ayuno", "riesgoAnestesico"],
  },
  POSTOPERATORIA: {
    titulo: "Nota postoperatoria",
    fundamento: "NOM-004-SSA3-2012 §8.8",
    medica: true,
    obligatorias: [
      "diagnosticoPreoperatorio",
      "operacionRealizada",
      "diagnosticoPostoperatorio",
      "tecnica",
      "hallazgos",
      "sangrado",
      "conteoGasas",
      "incidentes",
      "estadoPostquirurgico",
      "plan",
    ],
    opcionales: ["operacionPlaneada", "equipoQuirurgico", "piezasPatologia", "pronostico", "estudiosTransoperatorios"],
  },
  POSTANESTESICA: {
    titulo: "Nota postanestésica",
    fundamento: "NOM-004-SSA3-2012 §8.7 · NOM-026-SSA3-2012 (Aldrete)",
    medica: true,
    obligatorias: ["medicamentos", "duracion", "incidentes", "liquidos", "estadoEgresoQuirofano", "aldrete", "plan"],
    opcionales: ["tecnicaAnestesica", "sangrado", "dolor"],
  },
  ENFERMERIA: {
    titulo: "Hoja de enfermería",
    fundamento: "NOM-004-SSA3-2012 §9.1",
    medica: false,
    obligatorias: ["signosVitales", "medicamentosMinistrados", "procedimientos", "observaciones"],
    opcionales: ["habitusExterior", "dieta", "balanceLiquidos", "escalaDolor"],
  },
  HOJA_URGENCIAS: {
    titulo: "Hoja de urgencias",
    fundamento: "NOM-004-SSA3-2012 §7.1 · NOM-027-SSA3-2013 (triage)",
    medica: true,
    obligatorias: ["triageNivel", "motivoAtencion", "signosVitales", "resumenInterrogatorio", "exploracionFisica", "diagnosticos", "tratamiento", "pronostico"],
    opcionales: ["estudios", "destino", "estadoMental"],
  },
  INDICACION: {
    titulo: "Indicaciones médicas",
    fundamento: "NOM-004-SSA3-2012 §8.2.1",
    medica: true,
    obligatorias: [],
    opcionales: ["dieta", "soluciones", "medicamentos", "cuidados", "estudios"],
  },
  INTERCONSULTA: {
    titulo: "Nota de interconsulta",
    fundamento: "NOM-004-SSA3-2012 §8.3",
    medica: true,
    obligatorias: ["criteriosDiagnosticos", "sugerenciasDiagnosticas", "sugerenciasTratamiento"],
    opcionales: ["motivo", "especialidad"],
  },
  REFERENCIA: {
    titulo: "Nota de referencia / traslado",
    fundamento: "NOM-004-SSA3-2012 §8.9",
    medica: true,
    obligatorias: ["establecimientoReceptor", "motivoEnvio", "impresionDiagnostica", "terapeuticaEmpleada"],
    opcionales: ["establecimientoEnvia", "medicoReceptor", "condicionesTraslado"],
  },
  PROCEDIMIENTO: {
    titulo: "Nota de procedimiento",
    fundamento: "NOM-004-SSA3-2012 §8.8",
    medica: true,
    obligatorias: [],
    opcionales: ["descripcion", "hallazgos", "complicaciones", "materialUtilizado"],
  },
  MEDICAMENTO_APLICADO: {
    titulo: "Medicamento aplicado",
    fundamento: "NOM-004-SSA3-2012 §9.1.3",
    medica: false,
    obligatorias: [],
    opcionales: ["medicamento", "dosis", "via", "lote", "reaccion"],
  },
  EGRESO: {
    titulo: "Nota de egreso",
    fundamento: "NOM-004-SSA3-2012 §8.10 · NOM-026-SSA3-2012 (instrucciones de egreso)",
    medica: true,
    obligatorias: ["diagnosticoEgreso", "motivoEgreso", "evolucion", "planManejo"],
    opcionales: ["problemasPendientes", "pronostico", "recomendaciones", "causaDefuncion", "diasEstancia"],
  },
};

/** Etiqueta en español de cada sección, para las plantillas del satélite. */
export const ETIQUETA_SECCION: Record<string, string> = {
  antecedentesHeredofamiliares: "Antecedentes heredofamiliares",
  antecedentesPersonalesPatologicos: "Antecedentes personales patológicos",
  antecedentesPersonalesNoPatologicos: "Antecedentes personales no patológicos",
  antecedentesGinecoObstetricos: "Antecedentes gineco-obstétricos",
  padecimientoActual: "Padecimiento actual",
  interrogatorioAparatosSistemas: "Interrogatorio por aparatos y sistemas",
  exploracionFisica: "Exploración física",
  estudiosPrevios: "Resultados de estudios previos",
  signosVitales: "Signos vitales",
  diagnosticos: "Diagnósticos o problemas clínicos",
  pronostico: "Pronóstico",
  plan: "Plan de manejo y tratamiento",
  resumenInterrogatorio: "Resumen del interrogatorio",
  estudios: "Resultados de estudios",
  tratamiento: "Tratamiento",
  subjetivo: "Subjetivo (lo que refiere el paciente)",
  objetivo: "Objetivo (exploración, signos, estudios)",
  analisis: "Análisis",
  diagnostico: "Diagnóstico",
  planQuirurgico: "Plan quirúrgico",
  tipoIntervencion: "Tipo de intervención",
  riesgoQuirurgico: "Riesgo quirúrgico",
  fechaCirugia: "Fecha de la cirugía",
  cuidadosPreoperatorios: "Cuidados preoperatorios",
  evaluacionClinica: "Evaluación clínica",
  asa: "Clasificación ASA",
  tipoAnestesia: "Tipo de anestesia",
  planAnestesico: "Plan anestésico",
  medicacionPreanestesica: "Medicación preanestésica",
  viaAerea: "Vía aérea",
  ayuno: "Ayuno",
  riesgoAnestesico: "Riesgo anestésico",
  diagnosticoPreoperatorio: "Diagnóstico preoperatorio",
  operacionPlaneada: "Operación planeada",
  operacionRealizada: "Operación realizada",
  diagnosticoPostoperatorio: "Diagnóstico postoperatorio",
  tecnica: "Descripción de la técnica",
  hallazgos: "Hallazgos transoperatorios",
  sangrado: "Cuantificación de sangrado",
  conteoGasas: "Reporte de gasas y compresas",
  incidentes: "Incidentes y accidentes",
  estadoPostquirurgico: "Estado postquirúrgico inmediato",
  equipoQuirurgico: "Equipo quirúrgico (ayudantes, instrumentista, anestesiólogo, circulante)",
  piezasPatologia: "Piezas enviadas a patología",
  estudiosTransoperatorios: "Estudios transoperatorios",
  medicamentos: "Medicamentos utilizados",
  duracion: "Duración de la anestesia",
  liquidos: "Sangre y soluciones aplicadas",
  estadoEgresoQuirofano: "Estado clínico al egreso de quirófano",
  aldrete: "Escala de Aldrete (0-10)",
  tecnicaAnestesica: "Técnica anestésica",
  dolor: "Dolor (0-10)",
  medicamentosMinistrados: "Medicamentos ministrados (fecha, hora, dosis, vía)",
  procedimientos: "Procedimientos realizados",
  observaciones: "Observaciones",
  habitusExterior: "Habitus exterior",
  dieta: "Dieta",
  balanceLiquidos: "Balance de líquidos",
  escalaDolor: "Escala de dolor",
  triageNivel: "Nivel de triage (1-5)",
  motivoAtencion: "Motivo de la atención",
  destino: "Destino (alta, hospitalización, traslado)",
  estadoMental: "Estado mental",
  soluciones: "Soluciones",
  cuidados: "Cuidados",
  criteriosDiagnosticos: "Criterios diagnósticos",
  sugerenciasDiagnosticas: "Sugerencias diagnósticas",
  sugerenciasTratamiento: "Sugerencias de tratamiento",
  motivo: "Motivo",
  especialidad: "Especialidad",
  establecimientoReceptor: "Establecimiento receptor",
  establecimientoEnvia: "Establecimiento que envía",
  motivoEnvio: "Motivo de envío",
  impresionDiagnostica: "Impresión diagnóstica",
  terapeuticaEmpleada: "Terapéutica empleada",
  medicoReceptor: "Médico receptor",
  condicionesTraslado: "Condiciones del traslado",
  descripcion: "Descripción",
  complicaciones: "Complicaciones",
  materialUtilizado: "Material utilizado",
  medicamento: "Medicamento",
  dosis: "Dosis",
  via: "Vía",
  lote: "Lote",
  reaccion: "Reacción",
  diagnosticoEgreso: "Diagnóstico(s) de egreso",
  motivoEgreso: "Motivo del egreso",
  evolucion: "Resumen de la evolución y estado actual",
  planManejo: "Plan de manejo, tratamiento e instrucciones de egreso",
  problemasPendientes: "Problemas clínicos pendientes",
  recomendaciones: "Recomendaciones de vigilancia ambulatoria",
  causaDefuncion: "Causas de defunción",
  diasEstancia: "Días de estancia",
};

// ── Escalas ──────────────────────────────────────────────────────────────────

export const ASA_VALORES = ["I", "II", "III", "IV", "V", "VI"] as const;
const ASA_RE = /^(I|II|III|IV|V|VI)E?$/;

/** «asa ii e» → «IIE»; null si vacío. Lanza 400 si no es una clase ASA. */
export function normalizarAsa(entrada: string | null | undefined): string | null {
  const v = (entrada ?? "").toUpperCase().replace(/\s+/g, "");
  if (!v) return null;
  if (!ASA_RE.test(v)) throw new HospitalError(400, "La clasificación ASA es I, II, III, IV, V o VI (con E si es urgencia)");
  return v;
}

const esEntero = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Reglas de valor de las secciones que son escalas, no texto. */
const REGLAS_VALOR: Record<string, (v: unknown) => string | null> = {
  aldrete: (v) => (esEntero(v, 0, 10) ? null : "aldrete debe ser un entero de 0 a 10"),
  triageNivel: (v) => (esEntero(v, 1, 5) ? null : "triageNivel debe ser un entero de 1 a 5"),
  dolor: (v) => (esEntero(v, 0, 10) ? null : "dolor debe ser un entero de 0 a 10"),
  asa: (v) => (typeof v === "string" && ASA_RE.test(v.toUpperCase().replace(/\s+/g, "")) ? null : "asa debe ser I, II, III, IV, V o VI (con E si es urgencia)"),
};

const MAX_SECCIONES = 60;
const MAX_TEXTO_SECCION = 20_000;
const MAX_BYTES_SECCIONES = 200_000;
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
 * Valida `secciones` contra la plantilla del tipo. Devuelve el motivo (en
 * español, listo para el piso) o null si cumple. Las secciones no previstas
 * se admiten (cada hospital agrega las suyas); las obligatorias no pueden
 * faltar ni venir vacías, y las escalas deben traer un valor válido.
 */
export function errorSecciones(tipo: HospNotaTipo, secciones: unknown): string | null {
  const plantilla = PLANTILLAS_NOTA[tipo];
  if (!plantilla) return `Tipo de nota desconocido: ${tipo}`;
  if (secciones == null) {
    if (!plantilla.obligatorias.length) return null;
    return `La ${plantilla.titulo.toLowerCase()} requiere las secciones: ${plantilla.obligatorias.join(", ")} (${plantilla.fundamento})`;
  }
  if (typeof secciones !== "object" || Array.isArray(secciones)) return "secciones debe ser un objeto { seccion: contenido }";
  const obj = secciones as Record<string, unknown>;
  const claves = Object.keys(obj);
  if (claves.length > MAX_SECCIONES) return `Demasiadas secciones (máximo ${MAX_SECCIONES})`;
  for (const k of claves) {
    if (!CLAVE_RE.test(k)) return `Nombre de sección inválido: «${k}»`;
    const v = obj[k];
    if (typeof v === "string" && v.length > MAX_TEXTO_SECCION) return `La sección ${k} excede ${MAX_TEXTO_SECCION} caracteres`;
    if (typeof v === "function" || typeof v === "symbol") return `La sección ${k} no es serializable`;
  }
  const faltan = plantilla.obligatorias.filter((s) => vacio(obj[s]));
  if (faltan.length) {
    return `A la ${plantilla.titulo.toLowerCase()} le faltan: ${faltan.map((s) => ETIQUETA_SECCION[s] ?? s).join(", ")} (${plantilla.fundamento})`;
  }
  for (const [seccion, regla] of Object.entries(REGLAS_VALOR)) {
    if (obj[seccion] !== undefined && obj[seccion] !== null) {
      const e = regla(obj[seccion]);
      if (e) return e;
    }
  }
  if (JSON.stringify(obj).length > MAX_BYTES_SECCIONES) return "Las secciones exceden el tamaño máximo (200 KB)";
  return null;
}

// ── Firma del sistema ────────────────────────────────────────────────────────

/** JSON con las llaves ordenadas en todos los niveles: el mismo contenido siempre da el mismo texto. */
export function canonico(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonico);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    return Object.keys(o)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        if (o[k] !== undefined) acc[k] = canonico(o[k]);
        return acc;
      }, {});
  }
  if (v instanceof Date) return v.toISOString();
  return v;
}

export interface ContenidoFirmable {
  episodioId: string;
  tipo: HospNotaTipo;
  fecha: Date;
  texto: string;
  secciones?: unknown;
  autorNombre: string;
  autorCedula?: string | null;
  medicoId?: string | null;
  reemplazaId?: string | null;
}

export function contenidoCanonicoNota(n: ContenidoFirmable): string {
  return JSON.stringify(
    canonico({
      episodioId: n.episodioId,
      tipo: n.tipo,
      fecha: n.fecha.toISOString(),
      texto: n.texto,
      secciones: n.secciones ?? null,
      autorNombre: n.autorNombre,
      autorCedula: n.autorCedula ?? null,
      medicoId: n.medicoId ?? null,
      reemplazaId: n.reemplazaId ?? null,
    })
  );
}

/** SHA-256 (hex) del contenido canónico: la firma del sistema de la nota. */
export function hashNota(n: ContenidoFirmable): string {
  return createHash("sha256").update(contenidoCanonicoNota(n), "utf8").digest("hex");
}

/** true/false si la nota tiene hash y coincide (o no) con su contenido; null si no fue sellada. */
export function verificarHashNota(n: ContenidoFirmable & { hash?: string | null }): boolean | null {
  if (!n.hash) return null;
  return hashNota(n) === n.hash;
}

// ── Crear (la única forma de escribir una nota) ──────────────────────────────

export interface CrearNotaArgs {
  companyId: string;
  episodioId: string;
  tipo: HospNotaTipo;
  texto: string;
  secciones?: unknown;
  fecha?: Date | null;
  medicoId?: string | null;
  /** Cédula de quien firma cuando no es un HospMedico (enfermería, médico externo). */
  autorCedula?: string | null;
  reemplazaId?: string | null;
  cargoId?: string | null;
  usuario: { id?: string | null; nombre: string };
  ahora?: Date;
}

/**
 * Valida plantilla y firma, calcula hash + sello y crea la nota. Lanza
 * HospitalError con el motivo. No toca el estado del episodio: quien llama
 * ya comprobó que existe, es de la empresa y no está cancelado.
 */
export async function crearNota(db: Db, args: CrearNotaArgs) {
  const plantilla = PLANTILLAS_NOTA[args.tipo];
  if (!plantilla) throw new HospitalError(400, `Tipo de nota desconocido: ${args.tipo}`);
  const texto = args.texto.trim();
  if (!texto) throw new HospitalError(400, "La nota necesita texto");
  const motivoSecciones = errorSecciones(args.tipo, args.secciones);
  if (motivoSecciones) throw new HospitalError(400, motivoSecciones);

  let autorCedula = args.autorCedula?.trim() || null;
  if (args.medicoId) {
    const medico = await db.hospMedico.findUnique({ where: { id: args.medicoId }, select: { companyId: true, nombre: true, cedula: true } });
    if (!medico || medico.companyId !== args.companyId) throw new HospitalError(400, "medicoId inválido");
    if (!medico.cedula?.trim()) {
      throw new HospitalError(409, `${medico.nombre} no tiene cédula profesional registrada: captúrala en Médicos antes de firmar notas (NOM-004)`);
    }
    autorCedula = medico.cedula.trim();
  }
  if (plantilla.medica && !autorCedula) {
    throw new HospitalError(400, `La ${plantilla.titulo.toLowerCase()} la firma un médico: indica medicoId (con cédula) o autorCedula (NOM-004)`);
  }

  if (args.reemplazaId) {
    const previa = await db.hospNota.findUnique({
      where: { id: args.reemplazaId },
      select: { episodioId: true, reemplazadaPor: { select: { id: true } } },
    });
    if (!previa || previa.episodioId !== args.episodioId) throw new HospitalError(400, "reemplazaId no es una nota de este episodio");
    if (previa.reemplazadaPor) throw new HospitalError(409, "Esa nota ya fue reemplazada por otra; corrige la versión vigente");
  }

  const ahora = args.ahora ?? new Date();
  const fecha = args.fecha ?? ahora;
  const secciones = args.secciones == null ? null : (canonico(args.secciones) as Prisma.InputJsonValue);
  const firmable: ContenidoFirmable = {
    episodioId: args.episodioId,
    tipo: args.tipo,
    fecha,
    texto,
    secciones,
    autorNombre: args.usuario.nombre,
    autorCedula,
    medicoId: args.medicoId ?? null,
    reemplazaId: args.reemplazaId ?? null,
  };

  return db.hospNota.create({
    data: {
      episodioId: args.episodioId,
      tipo: args.tipo,
      fecha,
      texto,
      secciones: secciones ?? undefined,
      autorUserId: args.usuario.id ?? null,
      autorNombre: args.usuario.nombre,
      autorCedula,
      medicoId: args.medicoId ?? null,
      reemplazaId: args.reemplazaId ?? null,
      cargoId: args.cargoId ?? null,
      hash: hashNota(firmable),
      selloAt: ahora,
    },
    include: { medico: { select: { id: true, nombre: true, especialidad: true } } },
  });
}
