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

import { z } from "zod";
import type { HospSexo } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { fechaSchema } from "./http";
import { validarCurp } from "./curp";
import { fechaLocal, partesLocales } from "./tz";
import { nombreCompleto } from "./util";

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
});

export type PacienteEntrada = z.infer<typeof pacienteSchema>;

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
