// ─────────────────────────────────────────────────────────────────────────────
// SAEH — la hoja de hospitalización tal como la guarda HospEgresoSaeh y los
// sociodemográficos del paciente que pide la GIIS, con su esquema zod para el
// PUT y la conversión fila ↔ objeto (los arreglos viven en Json).
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import type { HospEgresoSaeh, HospSexo, Prisma } from "@prisma/client";

export interface ComorbilidadSaeh {
  /** Clave DGIS de 4 caracteres («O150») o código clínico («O15.0»): se normaliza al exportar. */
  codigo: string;
  descripcion: string | null;
}

export interface ProcedimientoSaeh {
  codigo: string;
  descripcion: string | null;
  tipoAnestesia: number | null;
  quirofano: number | null;
  tiempoQuirofano: string | null;
  cedula: string | null;
}

export interface ProductoSaeh {
  condicionNacimiento: number | null;
  condicionNacidoVivo: number | null;
  folioCertificado: string | null;
  apgar5: number | null;
  reanimacion: number | null;
  alojamientoConjunto: number | null;
  lactanciaExclusiva: number | null;
}

/** Lo que la hoja aporta además de lo que ya vive en el episodio y el paciente. */
export interface HojaSaeh {
  nacioHospital: number | null;
  peso: number | null;
  talla: number | null;
  gratuidad: number | null;

  tipoServicioIngreso: number | null;
  claveServicioIngreso: string | null;
  serviciosAdicionales: string[];
  claveServicioEgreso: string | null;
  terapiaIntensivaDias: number | null;
  terapiaIntensivaHoras: number | null;
  terapiaIntermediaDias: number | null;
  terapiaIntermediaHoras: number | null;

  procedencia: number | null;
  especifiqueProcedencia: string | null;
  cluesProcedencia: string | null;
  cluesReferido: string | null;
  mujerFertil: number | null;

  descripcionAfeccionPrincipal: string | null;
  codigoAfeccionPrincipal: string | null;
  comorbilidades: ComorbilidadSaeh[];
  tipoAtencion: number | null;
  afeccionReseleccionada: string | null;
  causaExterna: string | null;
  codigoCausaExterna: string | null;
  morfologia: string | null;
  infeccionIntrahospitalaria: number | null;
  procedimientos: ProcedimientoSaeh[];

  folioLesion: string | null;
  ministerioPublico: number | null;
  folioCertificadoDefuncion: string | null;

  gestas: number | null;
  partos: number | null;
  abortos: number | null;
  cesareas: number | null;
  extraccionExpulsion: number | null;
  edadGestacional: number | null;
  tipoAtencionObstetrica: number | null;
  tipoParto: number | null;
  tipoProcAborto: number | null;
  productoEmbarazo: number | null;
  totalProductos: number | null;
  planificacionFamiliar: number | null;
  otroMetodo: string | null;
  productos: ProductoSaeh[];

  tipoUnidadPsiq: number | null;
  tipoServicioPsiq: number | null;

  medicoResponsableId: string | null;
}

export const HOJA_VACIA: HojaSaeh = {
  nacioHospital: null, peso: null, talla: null, gratuidad: null,
  tipoServicioIngreso: null, claveServicioIngreso: null, serviciosAdicionales: [], claveServicioEgreso: null,
  terapiaIntensivaDias: null, terapiaIntensivaHoras: null, terapiaIntermediaDias: null, terapiaIntermediaHoras: null,
  procedencia: null, especifiqueProcedencia: null, cluesProcedencia: null, cluesReferido: null, mujerFertil: null,
  descripcionAfeccionPrincipal: null, codigoAfeccionPrincipal: null, comorbilidades: [], tipoAtencion: null, afeccionReseleccionada: null,
  causaExterna: null, codigoCausaExterna: null, morfologia: null, infeccionIntrahospitalaria: null, procedimientos: [],
  folioLesion: null, ministerioPublico: null, folioCertificadoDefuncion: null,
  gestas: null, partos: null, abortos: null, cesareas: null, extraccionExpulsion: null, edadGestacional: null, tipoAtencionObstetrica: null,
  tipoParto: null, tipoProcAborto: null, productoEmbarazo: null, totalProductos: null, planificacionFamiliar: null, otroMetodo: null, productos: [],
  tipoUnidadPsiq: null, tipoServicioPsiq: null,
  medicoResponsableId: null,
};

/** Campos del paciente que la GIIS pide y que viven en HospPaciente. */
export interface PacienteSaeh {
  id: string;
  nombre: string;
  apellidoPaterno: string;
  apellidoMaterno: string | null;
  fechaNacimiento: Date | null;
  sexo: HospSexo | null;
  curp: string | null;
  sinCurp: boolean;
  nacionalidad: string | null;
  /** Texto libre de la ficha («Puebla»): sirve para proponer la clave. */
  entidadNacimiento: string | null;
  municipio: string | null;
  estado: string | null;

  paisNacimientoClave: string | null;
  entidadNacimientoClave: string | null;
  estadoConyugal: number | null;
  seConsideraIndigena: boolean | null;
  hablaLenguaIndigena: boolean | null;
  lenguaIndigenaClave: string | null;
  seConsideraAfromexicano: boolean | null;
  esMigranteRetornado: boolean | null;
  seIdentificaLgbti: number | null;
  genero: number | null;
  paisResidenciaClave: string | null;
  entidadResidenciaClave: string | null;
  municipioResidenciaClave: string | null;
  localidadResidenciaClave: string | null;
  otraLocalidad: string | null;
  derechohabienciaClave: string | null;
  codigoPostal: string | null;
}

/** Los sociodemográficos que el PUT de la hoja puede guardar en el paciente. */
export const CAMPOS_PACIENTE_SAEH = [
  "paisNacimientoClave", "entidadNacimientoClave", "estadoConyugal", "seConsideraIndigena", "hablaLenguaIndigena", "lenguaIndigenaClave",
  "seConsideraAfromexicano", "esMigranteRetornado", "seIdentificaLgbti", "genero", "paisResidenciaClave", "entidadResidenciaClave",
  "municipioResidenciaClave", "localidadResidenciaClave", "otraLocalidad", "derechohabienciaClave", "codigoPostal",
] as const;
export type CampoPacienteSaeh = (typeof CAMPOS_PACIENTE_SAEH)[number];

// ── Fila ↔ hoja ───────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function lista<T>(json: unknown, cada: (o: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(json)) return [];
  const out: T[] = [];
  for (const item of json) {
    const o = obj(item);
    if (!o) continue;
    const t = cada(o);
    if (t) out.push(t);
  }
  return out;
}

export function comorbilidadesDeJson(json: unknown): ComorbilidadSaeh[] {
  return lista(json, (o) => {
    const codigo = str(o.codigo)?.trim();
    return codigo ? { codigo, descripcion: str(o.descripcion) } : null;
  });
}

export function procedimientosDeJson(json: unknown): ProcedimientoSaeh[] {
  return lista(json, (o) => {
    const codigo = str(o.codigo)?.trim();
    if (!codigo) return null;
    return {
      codigo,
      descripcion: str(o.descripcion),
      tipoAnestesia: num(o.tipoAnestesia),
      quirofano: num(o.quirofano),
      tiempoQuirofano: str(o.tiempoQuirofano),
      cedula: str(o.cedula),
    };
  });
}

export function productosDeJson(json: unknown): ProductoSaeh[] {
  return lista(json, (o) => ({
    condicionNacimiento: num(o.condicionNacimiento),
    condicionNacidoVivo: num(o.condicionNacidoVivo),
    folioCertificado: str(o.folioCertificado),
    apgar5: num(o.apgar5),
    reanimacion: num(o.reanimacion),
    alojamientoConjunto: num(o.alojamientoConjunto),
    lactanciaExclusiva: num(o.lactanciaExclusiva),
  }));
}

/** HospEgresoSaeh → HojaSaeh (Decimal a número, Json a arreglos). Sin fila → hoja vacía. */
export function hojaDesdeFila(fila: HospEgresoSaeh | null | undefined): HojaSaeh {
  if (!fila) return { ...HOJA_VACIA };
  return {
    nacioHospital: fila.nacioHospital,
    peso: fila.peso == null ? null : Number(fila.peso),
    talla: fila.talla,
    gratuidad: fila.gratuidad,
    tipoServicioIngreso: fila.tipoServicioIngreso,
    claveServicioIngreso: fila.claveServicioIngreso,
    serviciosAdicionales: fila.serviciosAdicionales ?? [],
    claveServicioEgreso: fila.claveServicioEgreso,
    terapiaIntensivaDias: fila.terapiaIntensivaDias,
    terapiaIntensivaHoras: fila.terapiaIntensivaHoras,
    terapiaIntermediaDias: fila.terapiaIntermediaDias,
    terapiaIntermediaHoras: fila.terapiaIntermediaHoras,
    procedencia: fila.procedencia,
    especifiqueProcedencia: fila.especifiqueProcedencia,
    cluesProcedencia: fila.cluesProcedencia,
    cluesReferido: fila.cluesReferido,
    mujerFertil: fila.mujerFertil,
    descripcionAfeccionPrincipal: fila.descripcionAfeccionPrincipal,
    codigoAfeccionPrincipal: fila.codigoAfeccionPrincipal,
    comorbilidades: comorbilidadesDeJson(fila.comorbilidades),
    tipoAtencion: fila.tipoAtencion,
    afeccionReseleccionada: fila.afeccionReseleccionada,
    causaExterna: fila.causaExterna,
    codigoCausaExterna: fila.codigoCausaExterna,
    morfologia: fila.morfologia,
    infeccionIntrahospitalaria: fila.infeccionIntrahospitalaria,
    procedimientos: procedimientosDeJson(fila.procedimientos),
    folioLesion: fila.folioLesion,
    ministerioPublico: fila.ministerioPublico,
    folioCertificadoDefuncion: fila.folioCertificadoDefuncion,
    gestas: fila.gestas,
    partos: fila.partos,
    abortos: fila.abortos,
    cesareas: fila.cesareas,
    extraccionExpulsion: fila.extraccionExpulsion,
    edadGestacional: fila.edadGestacional,
    tipoAtencionObstetrica: fila.tipoAtencionObstetrica,
    tipoParto: fila.tipoParto,
    tipoProcAborto: fila.tipoProcAborto,
    productoEmbarazo: fila.productoEmbarazo,
    totalProductos: fila.totalProductos,
    planificacionFamiliar: fila.planificacionFamiliar,
    otroMetodo: fila.otroMetodo,
    productos: productosDeJson(fila.productos),
    tipoUnidadPsiq: fila.tipoUnidadPsiq,
    tipoServicioPsiq: fila.tipoServicioPsiq,
    medicoResponsableId: fila.medicoResponsableId,
  };
}

// ── Esquema del PUT ──────────────────────────────────────────────────────────

const entero = (min: number, max: number) => z.number().int().min(min).max(max).nullable().optional();
const texto = (max: number) => z.string().trim().max(max).nullable().optional();
const booleano = () => z.boolean().nullable().optional();

export const comorbilidadSchema = z.object({
  codigo: z.string().trim().min(3).max(10),
  descripcion: texto(250),
});

export const procedimientoSchema = z.object({
  codigo: z.string().trim().min(2).max(10),
  descripcion: texto(250),
  tipoAnestesia: entero(1, 9),
  quirofano: entero(1, 9),
  tiempoQuirofano: texto(5),
  cedula: texto(20),
});

export const productoSchema = z.object({
  condicionNacimiento: entero(1, 9),
  condicionNacidoVivo: entero(1, 9),
  folioCertificado: texto(17),
  apgar5: entero(0, 88),
  reanimacion: entero(1, 8),
  alojamientoConjunto: entero(1, 8),
  lactanciaExclusiva: entero(1, 8),
});

/** Tipos y rangos gruesos; las reglas del diccionario viven en validar.ts (salen como `validacion.errores`, no como 400). */
export const hojaEntradaSchema = z.object({
  nacioHospital: entero(1, 8),
  peso: z.number().min(0).max(999).nullable().optional(),
  talla: entero(0, 999),
  gratuidad: entero(1, 8),
  tipoServicioIngreso: entero(1, 2),
  claveServicioIngreso: texto(4),
  serviciosAdicionales: z.array(z.string().trim().min(1).max(4)).max(6).optional(),
  claveServicioEgreso: texto(4),
  terapiaIntensivaDias: entero(0, 99),
  terapiaIntensivaHoras: entero(0, 99),
  terapiaIntermediaDias: entero(0, 99),
  terapiaIntermediaHoras: entero(0, 99),
  procedencia: entero(1, 5),
  especifiqueProcedencia: texto(50),
  cluesProcedencia: texto(11),
  cluesReferido: texto(11),
  mujerFertil: entero(-1, 3),
  descripcionAfeccionPrincipal: texto(250),
  codigoAfeccionPrincipal: texto(10),
  comorbilidades: z.array(comorbilidadSchema).max(10).optional(),
  tipoAtencion: entero(1, 2),
  afeccionReseleccionada: texto(10),
  causaExterna: texto(250),
  codigoCausaExterna: texto(10),
  morfologia: texto(10),
  infeccionIntrahospitalaria: entero(1, 2),
  procedimientos: z.array(procedimientoSchema).max(12).optional(),
  folioLesion: texto(8),
  ministerioPublico: entero(-1, 2),
  folioCertificadoDefuncion: texto(17),
  gestas: entero(0, 99),
  partos: entero(0, 99),
  abortos: entero(0, 99),
  cesareas: entero(0, 99),
  extraccionExpulsion: entero(-1, 2),
  edadGestacional: entero(0, 99),
  tipoAtencionObstetrica: entero(-1, 2),
  tipoParto: entero(-1, 9),
  tipoProcAborto: entero(-1, 9),
  productoEmbarazo: entero(-1, 3),
  totalProductos: entero(0, 9),
  planificacionFamiliar: entero(-1, 13),
  otroMetodo: texto(250),
  productos: z.array(productoSchema).max(8).optional(),
  tipoUnidadPsiq: entero(-1, 3),
  tipoServicioPsiq: entero(-1, 9),
  medicoResponsableId: z.string().min(1).nullable().optional(),
});
export type HojaEntrada = z.infer<typeof hojaEntradaSchema>;

export const pacienteSaehSchema = z.object({
  paisNacimientoClave: texto(3),
  entidadNacimientoClave: texto(2),
  estadoConyugal: entero(0, 9),
  seConsideraIndigena: booleano(),
  hablaLenguaIndigena: booleano(),
  lenguaIndigenaClave: texto(4),
  seConsideraAfromexicano: booleano(),
  esMigranteRetornado: booleano(),
  seIdentificaLgbti: entero(1, 8),
  genero: entero(-1, 6),
  paisResidenciaClave: texto(3),
  entidadResidenciaClave: texto(2),
  municipioResidenciaClave: texto(5),
  localidadResidenciaClave: texto(9),
  otraLocalidad: texto(50),
  derechohabienciaClave: texto(2),
  codigoPostal: texto(5),
});
export type PacienteSaehEntrada = z.infer<typeof pacienteSaehSchema>;

/** Sólo las llaves presentes en el body (undefined = no tocar); los arreglos van como Json. */
export function datosHojaParaGuardar(e: HojaEntrada): Prisma.HospEgresoSaehUncheckedUpdateInput {
  const d: Prisma.HospEgresoSaehUncheckedUpdateInput = {};
  const asigna = <K extends keyof HojaEntrada>(k: K, valor: (v: NonNullable<HojaEntrada[K]>) => unknown = (v) => v) => {
    if (e[k] === undefined) return;
    (d as Record<string, unknown>)[k] = e[k] === null ? null : valor(e[k] as NonNullable<HojaEntrada[K]>);
  };
  for (const k of Object.keys(e) as (keyof HojaEntrada)[]) {
    if (k === "comorbilidades" || k === "procedimientos" || k === "productos") {
      if (e[k] !== undefined) (d as Record<string, unknown>)[k] = (e[k] ?? []) as Prisma.InputJsonValue;
    } else if (k === "serviciosAdicionales") {
      if (e[k] !== undefined) d.serviciosAdicionales = e[k] ?? [];
    } else if (k === "codigoAfeccionPrincipal" || k === "afeccionReseleccionada" || k === "codigoCausaExterna" || k === "claveServicioIngreso" || k === "claveServicioEgreso" || k === "cluesProcedencia" || k === "cluesReferido" || k === "morfologia") {
      asigna(k, (v) => String(v).trim().toUpperCase() || null);
    } else {
      asigna(k);
    }
  }
  return d;
}

/** Igual para el paciente: sólo lo que vino, con claves en mayúsculas. */
export function datosPacienteParaGuardar(e: PacienteSaehEntrada): Prisma.HospPacienteUncheckedUpdateInput {
  const d: Record<string, unknown> = {};
  for (const k of CAMPOS_PACIENTE_SAEH) {
    const v = e[k];
    if (v === undefined) continue;
    d[k] = typeof v === "string" ? v.trim().toUpperCase() || null : v;
  }
  return d as Prisma.HospPacienteUncheckedUpdateInput;
}
