// Esquema y validación de vínculos del paciente, compartidos por POST
// /pacientes y PATCH /pacientes/[id]. Viven fuera de route.ts porque Next no
// admite exports ajenos a los handlers en un archivo de ruta.
//
// Identidad (NOM-024-SSA3-2012): la CURP es la llave del paciente. Se valida
// localmente (formato, fecha, sexo, entidad, dígito verificador) y lo que la
// CURP dice del titular se cruza con la ficha: fecha de nacimiento y sexo no
// pueden contradecirla, y si faltan se toman de ella. Sólo se admite un
// paciente sin CURP con `sinCurp` + `sinCurpMotivo` (extranjero sin CURP,
// recién nacido sin registro). El número de expediente se asigna al crear y
// nunca se edita; el aviso de privacidad (LFPDPPP) deja versión y fecha.
//
// P2: de dónde salió la CURP (`curpOrigen`; RENAPO sólo lo pone
// /verificar-curp), si es una CURP calculada (`curpProbable`), el RFC
// validado estructuralmente con su fuente, la identificación oficial con
// vigencia, y los sociodemográficos SAEH (GIIS-B002) con claves que deben
// existir en HospCatalogo: país, entidad, municipio (hijo de la entidad),
// localidad (hija de entidad+municipio), lengua indígena y afiliación.

import { z } from "zod";
import type { HospCurpOrigen, HospSexo } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validarRfc } from "@/lib/fiscal/verificador/estructura";
import { fechaSchema } from "./http";
import { validarCurp } from "./curp";
import { ENTIDAD_DGIS_POR_CURP, RFC_GENERICOS, identidadDePaciente, type PacienteIdentidadEntrada } from "./identidad";
import { fechaLocal, partesLocales } from "./tz";
import { nombreCompleto } from "./util";

const claveCatalogo = (max: number) => z.string().trim().regex(/^\d+$/, "Clave numérica del catálogo DGIS").max(max).nullable().optional();
const bandera = z.boolean().nullable().optional();

/** Orígenes que puede declarar la captura; RENAPO sólo lo fija /verificar-curp. */
export const CURP_ORIGENES_CAPTURA = ["CAPTURA", "DOCUMENTO", "CALCULADA"] as const;

export const pacienteSchema = z.object({
  nombre: z.string().min(1).max(120),
  apellidoPaterno: z.string().min(1).max(120),
  apellidoMaterno: z.string().max(120).nullable().optional(),
  fechaNacimiento: fechaSchema.nullable().optional(),
  sexo: z.enum(["FEMENINO", "MASCULINO", "OTRO"]).nullable().optional(),
  curp: z.string().max(18).nullable().optional(),
  sinCurp: z.boolean().optional(),
  sinCurpMotivo: z.string().max(200).nullable().optional(),
  nacionalidad: z.string().min(2).max(3).nullable().optional(),
  entidadNacimiento: z.string().max(60).nullable().optional(),
  telefono: z.string().max(30).nullable().optional(),
  email: z.string().email().max(120).nullable().optional(),
  domicilio: z.string().max(300).nullable().optional(),
  calle: z.string().max(120).nullable().optional(),
  numeroExterior: z.string().max(20).nullable().optional(),
  numeroInterior: z.string().max(20).nullable().optional(),
  colonia: z.string().max(120).nullable().optional(),
  municipio: z.string().max(120).nullable().optional(),
  estado: z.string().max(60).nullable().optional(),
  codigoPostal: z.string().regex(/^\d{5}$/, "Código postal de 5 dígitos").nullable().optional(),
  tipoSangre: z.string().max(5).nullable().optional(),
  alergias: z.string().max(500).nullable().optional(),
  antecedentes: z.string().max(4000).nullable().optional(),
  contactoEmergenciaNombre: z.string().max(120).nullable().optional(),
  contactoEmergenciaTelefono: z.string().max(30).nullable().optional(),
  contactoEmergenciaParentesco: z.string().max(60).nullable().optional(),
  avisoPrivacidadVersion: z.string().max(40).nullable().optional(),
  avisoPrivacidadAceptadoAt: fechaSchema.nullable().optional(),
  /** Atajo: true = aceptó ahora la versión vigente de HospConfig. */
  avisoPrivacidadAceptado: z.boolean().optional(),
  customerId: z.string().nullable().optional(),
  pagadorId: z.string().nullable().optional(),
  notas: z.string().max(4000).nullable().optional(),
  activo: z.boolean().optional(),

  // ── P2 identidad ──
  /** De dónde salió la CURP capturada (RENAPO lo pone el hub al verificar). */
  curpOrigen: z.enum(CURP_ORIGENES_CAPTURA).nullable().optional(),
  /** CURP calculada con homoclave supuesta, pendiente de confirmar. */
  curpProbable: z.boolean().optional(),
  /** Obligatorio para cambiar una CURP ya verificada en RENAPO. */
  motivoCambio: z.string().trim().min(5).max(300).optional(),
  rfc: z.string().trim().max(13).nullable().optional(),
  rfcFuente: z.enum(["CAPTURA", "CSF", "CALCULADO"]).nullable().optional(),
  identificacionTipo: z.enum(["INE", "PASAPORTE", "LICENCIA", "CEDULA_PROFESIONAL", "CARTILLA", "CSF", "OTRO"]).nullable().optional(),
  identificacionNumero: z.string().trim().max(40).nullable().optional(),
  identificacionVigencia: fechaSchema.nullable().optional(),

  // ── SAEH (GIIS-B002-05-09) ──
  paisNacimientoClave: claveCatalogo(3),
  entidadNacimientoClave: claveCatalogo(2),
  estadoConyugal: z.number().int().min(1).max(99).nullable().optional(),
  seConsideraIndigena: bandera,
  hablaLenguaIndigena: bandera,
  lenguaIndigenaClave: claveCatalogo(4),
  seConsideraAfromexicano: bandera,
  esMigranteRetornado: bandera,
  /** 1 sí · 2 no · 3 prefiere no responder. */
  seIdentificaLgbti: z.number().int().min(1).max(3).nullable().optional(),
  genero: z.number().int().min(1).max(99).nullable().optional(),
  paisResidenciaClave: claveCatalogo(3),
  entidadResidenciaClave: claveCatalogo(2),
  /** 3 dígitos del municipio dentro de la entidad («114»); también se acepta la clave completa («21114»). */
  municipioResidenciaClave: claveCatalogo(5),
  /** 4 dígitos de la localidad dentro del municipio («0001»); también la clave completa («211140001»). */
  localidadResidenciaClave: claveCatalogo(9),
  otraLocalidad: z.string().trim().max(120).nullable().optional(),
  derechohabienciaClave: claveCatalogo(3),
});

export type PacienteEntrada = z.infer<typeof pacienteSchema>;

/** Campos del body que NO se guardan tal cual (los resuelven las reglas de identidad). */
export const CAMPOS_IDENTIDAD_P1 = ["fechaNacimiento", "curp", "sinCurp", "sinCurpMotivo", "sexo", "entidadNacimiento", "avisoPrivacidadAceptado", "avisoPrivacidadAceptadoAt", "avisoPrivacidadVersion"] as const;
export const CAMPOS_IDENTIDAD_P2 = ["curpOrigen", "curpProbable", "motivoCambio", "rfc", "rfcFuente", "identificacionTipo", "identificacionNumero", "identificacionVigencia"] as const;
export const CAMPOS_SAEH = [
  "paisNacimientoClave", "entidadNacimientoClave", "estadoConyugal", "seConsideraIndigena", "hablaLenguaIndigena", "lenguaIndigenaClave", "seConsideraAfromexicano",
  "esMigranteRetornado", "seIdentificaLgbti", "genero", "paisResidenciaClave", "entidadResidenciaClave", "municipioResidenciaClave", "localidadResidenciaClave", "otraLocalidad", "derechohabienciaClave",
] as const;

/**
 * Fecha de nacimiento del body: «1992-03-14» a secas es el DÍA local (se
 * guarda al mediodía para que ningún huso lo mueva de día); un ISO con hora
 * es el instante.
 */
export function fechaNacimientoDe(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (m) return fechaLocal(Number(m[1]), Number(m[2]), Number(m[3]), 12);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface IdentidadPaciente {
  curp: string | null;
  curpValidada: boolean;
  sinCurp: boolean;
  sinCurpMotivo: string | null;
  sexo: HospSexo | null;
  fechaNacimiento: Date | null;
  entidadNacimiento: string | null;
}

export type ResultadoIdentidad = { ok: true; datos: IdentidadPaciente } | { ok: false; status: number; error: string };

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * Regla de identidad, pura: con `sinCurp` hace falta el motivo; si no, la
 * CURP es obligatoria (cuando `exigirCurp`) y válida, y la ficha no puede
 * contradecirla. Devuelve los campos ya resueltos para guardar.
 */
export function resolverIdentidadCurp(entrada: {
  curp?: string | null;
  sinCurp?: boolean | null;
  sinCurpMotivo?: string | null;
  sexo?: HospSexo | null;
  fechaNacimiento?: Date | null;
  entidadNacimiento?: string | null;
  exigirCurp: boolean;
}): ResultadoIdentidad {
  const base: IdentidadPaciente = {
    curp: null,
    curpValidada: false,
    sinCurp: false,
    sinCurpMotivo: null,
    sexo: entrada.sexo ?? null,
    fechaNacimiento: entrada.fechaNacimiento ?? null,
    entidadNacimiento: entrada.entidadNacimiento?.trim() || null,
  };
  if (entrada.sinCurp) {
    const motivo = entrada.sinCurpMotivo?.trim();
    if (!motivo) return { ok: false, status: 400, error: "Indica el motivo por el que el paciente no tiene CURP (extranjero sin CURP, recién nacido sin registro…)" };
    return { ok: true, datos: { ...base, sinCurp: true, sinCurpMotivo: motivo } };
  }
  const curp = (entrada.curp ?? "").trim().toUpperCase();
  if (!curp) {
    if (entrada.exigirCurp) return { ok: false, status: 400, error: "La CURP es obligatoria (NOM-024); si el paciente no tiene, marca sinCurp con su motivo" };
    return { ok: true, datos: base };
  }
  const r = validarCurp(curp);
  if (!r.valida || !r.fechaNacimiento || !r.sexo) return { ok: false, status: 400, error: r.motivo ?? "CURP inválida" };

  const nac = { y: r.fechaNacimiento.getUTCFullYear(), m: r.fechaNacimiento.getUTCMonth() + 1, d: r.fechaNacimiento.getUTCDate() };
  let fechaNacimiento = entrada.fechaNacimiento ?? null;
  if (fechaNacimiento) {
    const f = partesLocales(fechaNacimiento);
    if (f.y !== nac.y || f.m !== nac.m || f.d !== nac.d) {
      return { ok: false, status: 400, error: `La fecha de nacimiento (${iso(f.y, f.m, f.d)}) no coincide con la de la CURP (${iso(nac.y, nac.m, nac.d)})` };
    }
  } else {
    fechaNacimiento = fechaLocal(nac.y, nac.m, nac.d, 12);
  }
  let sexo = entrada.sexo ?? null;
  if (sexo === "FEMENINO" || sexo === "MASCULINO") {
    if (sexo !== r.sexo) return { ok: false, status: 400, error: `El sexo (${sexo.toLowerCase()}) no coincide con el de la CURP (${r.sexo.toLowerCase()})` };
  } else if (!sexo) {
    sexo = r.sexo;
  }
  return {
    ok: true,
    datos: {
      curp: r.curp,
      curpValidada: true,
      sinCurp: false,
      sinCurpMotivo: null,
      sexo,
      fechaNacimiento,
      entidadNacimiento: base.entidadNacimiento ?? r.entidad ?? null,
    },
  };
}

/** Otro paciente de la empresa con la misma CURP (para el 409 y para validar-curp). */
export async function pacienteConCurp(companyId: string, curp: string, excluirId?: string | null) {
  const p = await prisma.hospPaciente.findFirst({
    where: { companyId, curp, ...(excluirId ? { id: { not: excluirId } } : {}) },
    select: { id: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true, expedienteNumero: true, activo: true },
  });
  return p ? { id: p.id, nombreCompleto: nombreCompleto(p), expedienteNumero: p.expedienteNumero, activo: p.activo } : null;
}

export function mensajeCurpDuplicada(dup: { nombreCompleto: string; expedienteNumero: string | null }, curp: string): string {
  return `Ya existe un paciente con la CURP ${curp}: ${dup.nombreCompleto}${dup.expedienteNumero ? ` (${dup.expedienteNumero})` : ""}`;
}

/**
 * Lo que contesta validar-curp: el resultado local de RENAPO más si otro
 * paciente de la empresa ya la tiene (para que la captura avise antes del 409).
 */
export async function validarCurpParaEmpresa(companyId: string, entrada: string, excluirPacienteId?: string | null) {
  const r = validarCurp(entrada);
  const duplicado = r.valida ? await pacienteConCurp(companyId, r.curp, excluirPacienteId) : null;
  const f = r.fechaNacimiento;
  return {
    valida: r.valida,
    curp: r.curp,
    motivo: r.motivo ?? null,
    fechaNacimiento: f ? iso(f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate()) : null,
    sexo: r.sexo ?? null,
    entidad: r.entidad ?? null,
    entidadClave: r.valida ? r.curp.slice(11, 13) : null,
    duplicado,
  };
}

/**
 * Aviso de privacidad (LFPDPPP): si aceptó, queda la fecha y la versión
 * (la del body o la vigente en HospConfig). Devuelve sólo lo que cambia.
 */
export async function avisoPrivacidadDe(
  companyId: string,
  d: { avisoPrivacidadAceptado?: boolean; avisoPrivacidadAceptadoAt?: string | null; avisoPrivacidadVersion?: string | null },
  ahora: Date = new Date()
): Promise<{ avisoPrivacidadVersion?: string | null; avisoPrivacidadAceptadoAt?: Date | null }> {
  const aceptadoAt =
    d.avisoPrivacidadAceptado === true ? ahora : d.avisoPrivacidadAceptadoAt === undefined ? undefined : d.avisoPrivacidadAceptadoAt ? new Date(d.avisoPrivacidadAceptadoAt) : null;
  let version = d.avisoPrivacidadVersion;
  if (aceptadoAt && !version) {
    const cfg = await prisma.hospConfig.findUnique({ where: { companyId }, select: { avisoPrivacidadVersion: true } });
    version = cfg?.avisoPrivacidadVersion ?? null;
  }
  return {
    ...(aceptadoAt !== undefined ? { avisoPrivacidadAceptadoAt: aceptadoAt } : {}),
    ...(version !== undefined ? { avisoPrivacidadVersion: version || null } : {}),
  };
}

/** Los FK canónicos deben ser de la misma empresa (fail-closed). */
export async function validarVinculosPaciente(
  companyId: string,
  d: { customerId?: string | null; pagadorId?: string | null }
): Promise<string | null> {
  if (d.customerId) {
    const c = await prisma.customer.findUnique({ where: { id: d.customerId }, select: { companyId: true } });
    if (!c || c.companyId !== companyId) return "customerId inválido";
  }
  if (d.pagadorId) {
    const p = await prisma.hospPagador.findUnique({ where: { id: d.pagadorId }, select: { companyId: true } });
    if (!p || p.companyId !== companyId) return "pagadorId inválido";
  }
  return null;
}

// ── P2: RFC, identificación y origen de la CURP ──────────────────────────────

export interface DatosIdentidadP2 {
  rfc?: string | null;
  rfcFuente?: "CAPTURA" | "CSF" | "CALCULADO" | null;
  identificacionTipo?: PacienteEntrada["identificacionTipo"];
  identificacionNumero?: string | null;
  identificacionVigencia?: Date | null;
}

/**
 * RFC con estructura válida (o genérico XEXX010101000 / XAXX010101000) y su
 * fuente (CAPTURA cuando no se dice); identificación oficial con vigencia
 * como día local. Devuelve sólo lo que el body trajo.
 */
export function resolverDatosIdentidadP2(
  d: Pick<PacienteEntrada, "rfc" | "rfcFuente" | "identificacionTipo" | "identificacionNumero" | "identificacionVigencia">,
  actual: { rfc: string | null } | null
): { ok: true; datos: DatosIdentidadP2 } | { ok: false; status: number; error: string } {
  const datos: DatosIdentidadP2 = {};
  if (d.rfc !== undefined) {
    const rfc = d.rfc?.trim().toUpperCase() || null;
    if (rfc && !RFC_GENERICOS.has(rfc)) {
      const v = validarRfc(rfc);
      if (!v.formatoValido || v.digitoVerificador !== "valido") return { ok: false, status: 400, error: `RFC inválido: ${v.detalle ?? "revisa la clave"}` };
    }
    datos.rfc = rfc;
    datos.rfcFuente = rfc ? (d.rfcFuente ?? "CAPTURA") : null;
  } else if (d.rfcFuente !== undefined) {
    datos.rfcFuente = actual?.rfc ? d.rfcFuente : null;
  }
  if (d.identificacionTipo !== undefined) datos.identificacionTipo = d.identificacionTipo;
  if (d.identificacionNumero !== undefined) datos.identificacionNumero = d.identificacionNumero?.trim().toUpperCase() || null;
  if (d.identificacionVigencia !== undefined) {
    const f = fechaNacimientoDe(d.identificacionVigencia);
    if (d.identificacionVigencia && !f) return { ok: false, status: 400, error: "identificacionVigencia inválida (AAAA-MM-DD)" };
    datos.identificacionVigencia = f;
  }
  return { ok: true, datos };
}

/** Origen y «probable» de una CURP que entra por captura (nunca RENAPO desde el body). */
export function origenCurpDe(d: { curpOrigen?: HospCurpOrigen | null; curpProbable?: boolean }, hayCurp: boolean): { curpOrigen: HospCurpOrigen | null; curpProbable: boolean } {
  if (!hayCurp) return { curpOrigen: null, curpProbable: false };
  const curpOrigen = d.curpOrigen ?? "CAPTURA";
  return { curpOrigen, curpProbable: d.curpProbable ?? curpOrigen === "CALCULADA" };
}

/** Al cambiar la CURP se borra lo que RENAPO dijo de la anterior. */
export const REINICIO_VERIFICACION = {
  curpEstatus: null,
  curpVerificadaAt: null,
  curpVerificadaFuente: null,
  curpVerificadaRef: null,
  renapoNombres: null,
  renapoPrimerApellido: null,
  renapoSegundoApellido: null,
  renapoCoincide: null,
} as const;

// ── SAEH: claves de catálogo ─────────────────────────────────────────────────

const pad = (v: string, n: number) => v.padStart(n, "0");

export interface ClavesSaehNormalizadas {
  paisNacimientoClave?: string | null;
  entidadNacimientoClave?: string | null;
  lenguaIndigenaClave?: string | null;
  paisResidenciaClave?: string | null;
  entidadResidenciaClave?: string | null;
  municipioResidenciaClave?: string | null;
  localidadResidenciaClave?: string | null;
  derechohabienciaClave?: string | null;
}

async function existeClave(tipo: "PAIS" | "ENTIDAD" | "MUNICIPIO" | "LOCALIDAD" | "LENGUA" | "AFILIACION", clave: string): Promise<{ existe: boolean; datos: unknown }> {
  const fila = await prisma.hospCatalogo.findUnique({ where: { tipo_clave: { tipo, clave } }, select: { id: true, datos: true } });
  return { existe: !!fila, datos: fila?.datos ?? null };
}

const NOMBRE_CATALOGO_SAEH = { PAIS: "PAIS (países)", ENTIDAD: "ENTIDAD (entidades federativas)", MUNICIPIO: "MUNICIPIO", LOCALIDAD: "LOCALIDAD", LENGUA: "LENGUA (lenguas indígenas)", AFILIACION: "AFILIACION (derechohabiencia)" } as const;

/**
 * Normaliza y valida las claves sociodemográficas SAEH contra HospCatalogo:
 * país a 3 dígitos, entidad a 2, municipio a 3 (hijo de la entidad) y
 * localidad a 4 (hija de entidad+municipio). `entidadNacimientoClave` debe
 * ser coherente con la entidad de la CURP. Devuelve sólo lo que cambia.
 */
export async function validarClavesSaeh(
  d: Partial<PacienteEntrada>,
  actual: { entidadResidenciaClave: string | null; municipioResidenciaClave: string | null } | null,
  curp: string | null
): Promise<{ ok: true; datos: ClavesSaehNormalizadas } | { ok: false; status: number; error: string }> {
  const datos: ClavesSaehNormalizadas = {};
  const noExiste = (tipo: keyof typeof NOMBRE_CATALOGO_SAEH, campo: string, clave: string) => ({
    ok: false as const,
    status: 400,
    error: `${campo}: la clave ${clave} no existe en el catálogo ${NOMBRE_CATALOGO_SAEH[tipo]} de la DGIS`,
  });

  for (const campo of ["paisNacimientoClave", "paisResidenciaClave"] as const) {
    if (d[campo] === undefined) continue;
    const v = d[campo] ? pad(d[campo]!, 3) : null;
    if (v && !(await existeClave("PAIS", v)).existe) return noExiste("PAIS", campo, v);
    datos[campo] = v;
  }
  if (d.entidadNacimientoClave !== undefined) {
    const v = d.entidadNacimientoClave ? pad(d.entidadNacimientoClave, 2) : null;
    if (v) {
      const fila = await existeClave("ENTIDAD", v);
      if (!fila.existe) return noExiste("ENTIDAD", "entidadNacimientoClave", v);
      const abreviatura = (fila.datos as { abreviatura?: string } | null)?.abreviatura;
      const entidadCurp = curp && curp.length === 18 ? curp.slice(11, 13) : null;
      if (abreviatura && entidadCurp && abreviatura !== entidadCurp) {
        // Decir cuál SÍ es. El mensaje viejo enfrentaba dos claves y dos
        // abreviaturas sin nombrar la salida, y quien lo leía en un teléfono
        // no tenía cómo saber que «NE» de la CURP es el 00 del catálogo y no
        // el 88. Con la clave esperada, el error se corrige de una vez.
        const esperada = ENTIDAD_DGIS_POR_CURP[entidadCurp];
        const cual = esperada ? ` La CURP dice ${entidadCurp}, que en el catálogo es la ${esperada}.` : "";
        return {
          ok: false,
          status: 400,
          error: `La entidad de nacimiento ${v} (${abreviatura}) no coincide con la de la CURP (${entidadCurp}).${cual} Corrige la entidad o la CURP.`,
        };
      }
    }
    datos.entidadNacimientoClave = v;
  }
  if (d.lenguaIndigenaClave !== undefined) {
    const v = d.lenguaIndigenaClave ? pad(d.lenguaIndigenaClave, 4) : null;
    if (v && !(await existeClave("LENGUA", v)).existe) return noExiste("LENGUA", "lenguaIndigenaClave", v);
    datos.lenguaIndigenaClave = v;
  }
  if (d.derechohabienciaClave !== undefined) {
    const v = d.derechohabienciaClave ? String(Number(d.derechohabienciaClave)) : null;
    if (v && !(await existeClave("AFILIACION", v)).existe) return noExiste("AFILIACION", "derechohabienciaClave", v);
    datos.derechohabienciaClave = v;
  }

  // Residencia: la jerarquía entidad → municipio → localidad.
  let entidad = actual?.entidadResidenciaClave ?? null;
  if (d.entidadResidenciaClave !== undefined) {
    entidad = d.entidadResidenciaClave ? pad(d.entidadResidenciaClave, 2) : null;
    if (entidad && !(await existeClave("ENTIDAD", entidad)).existe) return noExiste("ENTIDAD", "entidadResidenciaClave", entidad);
    datos.entidadResidenciaClave = entidad;
  }
  let municipio = actual?.municipioResidenciaClave ?? null;
  if (d.municipioResidenciaClave !== undefined) {
    let v = d.municipioResidenciaClave || null;
    if (v) {
      if (v.length === 5 && entidad && v.startsWith(entidad)) v = v.slice(2);
      if (v.length > 3) return { ok: false, status: 400, error: "municipioResidenciaClave: usa los 3 dígitos del municipio dentro de la entidad (p. ej. 114)" };
      v = pad(v, 3);
      if (!entidad) return { ok: false, status: 400, error: "municipioResidenciaClave requiere entidadResidenciaClave" };
      if (!(await existeClave("MUNICIPIO", entidad + v)).existe) return noExiste("MUNICIPIO", "municipioResidenciaClave", `${entidad}${v}`);
    }
    municipio = v;
    datos.municipioResidenciaClave = v;
  } else if (d.entidadResidenciaClave !== undefined && entidad && municipio) {
    // Cambió la entidad y se quedó el municipio anterior: debe seguir existiendo bajo la nueva.
    if (!(await existeClave("MUNICIPIO", entidad + municipio)).existe) return noExiste("MUNICIPIO", "municipioResidenciaClave", `${entidad}${municipio}`);
  }
  if (d.localidadResidenciaClave !== undefined) {
    let v = d.localidadResidenciaClave || null;
    if (v) {
      if (v.length === 9 && entidad && municipio && v.startsWith(entidad + municipio)) v = v.slice(5);
      if (v.length > 4) return { ok: false, status: 400, error: "localidadResidenciaClave: usa los 4 dígitos de la localidad dentro del municipio (p. ej. 0001)" };
      v = pad(v, 4);
      if (!entidad || !municipio) return { ok: false, status: 400, error: "localidadResidenciaClave requiere entidadResidenciaClave y municipioResidenciaClave" };
      if (!(await existeClave("LOCALIDAD", entidad + municipio + v)).existe) return noExiste("LOCALIDAD", "localidadResidenciaClave", `${entidad}${municipio}${v}`);
    }
    datos.localidadResidenciaClave = v;
  }
  return { ok: true, datos };
}

/** Entidad y país de nacimiento que la CURP implica, cuando la captura no los trae. */
export function nacimientoDesdeCurp(curp: string | null): { entidadNacimientoClave: string | null; paisNacimientoClave: string | null } {
  if (!curp || curp.length !== 18) return { entidadNacimientoClave: null, paisNacimientoClave: null };
  const entidad = curp.slice(11, 13);
  const clave = ENTIDAD_DGIS_POR_CURP[entidad] ?? null;
  return { entidadNacimientoClave: clave, paisNacimientoClave: entidad === "NE" ? null : clave ? "142" : null };
}

// ── Utilería de las rutas ────────────────────────────────────────────────────

/** Separa un objeto en (las claves pedidas, el resto), sin mutar el original. */
export function partir<T extends object, K extends keyof T>(obj: T, claves: readonly K[]): [Pick<T, K>, Omit<T, K>] {
  const tomado = {} as Pick<T, K>;
  const resto = { ...obj } as T;
  for (const k of claves) {
    if (k in obj) tomado[k] = obj[k];
    delete (resto as Record<string, unknown>)[k as string];
  }
  return [tomado, resto as Omit<T, K>];
}

/** El bloque `identidad` de la ficha con la versión vigente del aviso de privacidad. */
export async function identidadDeFicha(p: PacienteIdentidadEntrada & { companyId: string }, hoy: Date = new Date()) {
  const cfg = await prisma.hospConfig.findUnique({ where: { companyId: p.companyId }, select: { avisoPrivacidadVersion: true } });
  return identidadDePaciente(p, cfg, hoy);
}
