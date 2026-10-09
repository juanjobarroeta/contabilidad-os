// Agenda por recurso: esquema de la cita, detección de empalmes y la forma
// con la que se responde. «Se agenda sin empalmes» (lámina 7): dos citas
// vivas (ni canceladas ni no-asistió) no comparten quirófano ni un minuto.

import { z } from "zod";
import { Prisma, type PrismaClient } from "@prisma/client";
import { fechaSchema } from "./http";
import { horaLocal } from "./tz";
import { nombreCompleto } from "./util";

type Db = PrismaClient | Prisma.TransactionClient;

export const CITA_TIPOS = ["CIRUGIA", "CONSULTA", "PROCEDIMIENTO", "ESTUDIO", "OTRO"] as const;
export const CITA_ESTADOS = ["SOLICITADA", "PROGRAMADA", "CONFIRMADA", "EN_CURSO", "TERMINADA", "CANCELADA", "NO_ASISTIO"] as const;
/**
 * Estados que no ocupan el recurso: no cuentan para empalmes ni como cirugía
 * programada. SOLICITADA es una petición por programar (hoja 2 del Excel).
 */
export const CITA_NO_OCUPA = ["SOLICITADA", "CANCELADA", "NO_ASISTIO"] as const;
export const ocupaRecurso = (estado: string) => !(CITA_NO_OCUPA as readonly string[]).includes(estado);

export const CITA_ESTANCIAS = ["AMBULATORIA", "HOSPITALIZACION"] as const;
export const INSUMO_ORIGENES = ["HOSPITAL", "PROVEEDOR", "PACIENTE"] as const;

/** Lo que se pide para el caso y quién lo trae (la hoja de quirófano lo separa). */
export const insumoCitaSchema = z.object({
  descripcion: z.string().trim().min(1).max(200),
  cantidad: z.number().positive().max(10000).nullable().optional(),
  origen: z.enum(INSUMO_ORIGENES).default("HOSPITAL"),
});
export type InsumoCita = z.infer<typeof insumoCitaSchema>;

const textoOpcional = (max: number) => z.string().max(max).nullable().optional();

export const citaCamposSchema = z.object({
  recursoId: z.string().min(1),
  tipo: z.enum(CITA_TIPOS),
  titulo: z.string().min(1).max(200),
  inicio: fechaSchema,
  fin: fechaSchema,
  pacienteId: z.string().nullable().optional(),
  pacienteNombre: z.string().max(200).nullable().optional(),
  medicoId: z.string().nullable().optional(),
  episodioId: z.string().nullable().optional(),
  cotizacionId: z.string().nullable().optional(),
  notas: z.string().max(2000).nullable().optional(),
  estado: z.enum(CITA_ESTADOS).optional(),
  anestesiologoId: z.string().nullable().optional(),
  anestesiologoConfirmado: z.boolean().optional(),
  tipoAnestesia: z.number().int().min(1).max(6).nullable().optional(),
  enfermera: textoOpcional(120),
  solicitaInstrumentista: z.boolean().optional(),
  instrumentista: textoOpcional(120),
  diagnostico: textoOpcional(300),
  estancia: z.enum(CITA_ESTANCIAS).nullable().optional(),
  camaId: z.string().nullable().optional(),
  insumos: z.array(insumoCitaSchema).max(40).nullable().optional(),
  horaPorDefinir: z.boolean().optional(),
  servicioId: z.string().nullable().optional(),
});
export type CitaCampos = z.infer<typeof citaCamposSchema>;

const limpio = (v: string | null | undefined) => v?.trim() || null;

/**
 * Columnas de la hoja (anestesiólogo, enfermera, insumos…) listas para
 * Prisma. Sólo trae las llaves que vinieron: en PATCH, lo que no se manda no
 * se toca. Cambiar de anestesiólogo vuelve a dejarlo «por confirmar».
 */
export interface DatosHojaCita {
  anestesiologoId?: string | null;
  anestesiologoConfirmado?: boolean;
  tipoAnestesia?: number | null;
  enfermera?: string | null;
  solicitaInstrumentista?: boolean;
  instrumentista?: string | null;
  diagnostico?: string | null;
  estancia?: (typeof CITA_ESTANCIAS)[number] | null;
  camaId?: string | null;
  insumos?: Prisma.InputJsonValue | typeof Prisma.DbNull;
  servicioId?: string | null;
}

export function datosHojaCita(d: Partial<CitaCampos>, actual?: { anestesiologoId: string | null } | null): DatosHojaCita {
  const out: DatosHojaCita = {};
  if (d.anestesiologoId !== undefined) {
    out.anestesiologoId = d.anestesiologoId || null;
    const cambio = (d.anestesiologoId || null) !== (actual?.anestesiologoId ?? null);
    if (!out.anestesiologoId) out.anestesiologoConfirmado = false;
    else if (cambio && d.anestesiologoConfirmado === undefined) out.anestesiologoConfirmado = false;
  }
  if (d.anestesiologoConfirmado !== undefined && out.anestesiologoConfirmado === undefined) out.anestesiologoConfirmado = d.anestesiologoConfirmado;
  if (d.tipoAnestesia !== undefined) out.tipoAnestesia = d.tipoAnestesia;
  if (d.enfermera !== undefined) out.enfermera = limpio(d.enfermera);
  if (d.solicitaInstrumentista !== undefined) out.solicitaInstrumentista = d.solicitaInstrumentista;
  if (d.instrumentista !== undefined) out.instrumentista = limpio(d.instrumentista);
  if (d.diagnostico !== undefined) out.diagnostico = limpio(d.diagnostico);
  if (d.estancia !== undefined) out.estancia = d.estancia;
  if (d.camaId !== undefined) out.camaId = d.camaId || null;
  if (d.insumos !== undefined) out.insumos = d.insumos?.length ? d.insumos : Prisma.DbNull;
  if (d.servicioId !== undefined) out.servicioId = d.servicioId || null;
  return out;
}

export const incluyeCita = {
  recurso: { select: { id: true, tipo: true, area: true, nombre: true } },
  paciente: { select: { id: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true, fechaNacimiento: true } },
  medico: { select: { id: true, nombre: true, especialidad: true } },
  anestesiologo: { select: { id: true, nombre: true, especialidad: true } },
  cama: { select: { id: true, nombre: true, area: true } },
  servicio: { select: { id: true, clave: true, nombre: true, grupo: true } },
  episodio: { select: { id: true, folio: true, estado: true } },
  cotizacion: { select: { id: true, folio: true, estado: true } },
} as const;

/**
 * La cita viva que se cruza con [inicio, fin) en el recurso, si la hay. Si el
 * recurso pide minutos de limpieza entre casos, el hueco cuenta: una cita que
 * termina a las 10:00 en un quirófano con 30 min choca con otra a las 10:15.
 */
export async function citaEmpalmada(
  db: Db,
  args: { recursoId: string; inicio: Date; fin: Date; excluirId?: string | null }
) {
  const recurso = await db.hospRecurso.findUnique({ where: { id: args.recursoId }, select: { minutosLimpieza: true } });
  const limpieza = recurso?.minutosLimpieza ?? 0;
  const ms = limpieza * 60_000;
  const choque = await db.hospCita.findFirst({
    where: {
      recursoId: args.recursoId,
      ...(args.excluirId ? { id: { not: args.excluirId } } : {}),
      estado: { notIn: [...CITA_NO_OCUPA] },
      inicio: { lt: new Date(args.fin.getTime() + ms) },
      fin: { gt: new Date(args.inicio.getTime() - ms) },
    },
    select: { id: true, titulo: true, inicio: true, fin: true, pacienteNombre: true, recurso: { select: { nombre: true } } },
    orderBy: { inicio: "asc" },
  });
  if (!choque) return null;
  // ¿Se enciman de verdad o sólo no deja el hueco de limpieza?
  const soloLimpieza = choque.inicio.getTime() >= args.fin.getTime() || choque.fin.getTime() <= args.inicio.getTime();
  return { ...choque, limpieza: soloLimpieza ? limpieza : 0 };
}

export function describirEmpalme(c: { titulo: string; inicio: Date; fin: Date; pacienteNombre: string | null; recurso: { nombre: string }; limpieza?: number }): string {
  const quien = c.pacienteNombre ? ` (${c.pacienteNombre})` : "";
  const base = `${c.recurso.nombre} ya tiene «${c.titulo}»${quien} de ${horaLocal(c.inicio)} a ${horaLocal(c.fin)}`;
  return c.limpieza ? `${base} y necesita ${c.limpieza} min de limpieza entre casos` : base;
}

export function serializarCita<T extends { paciente?: { id: string; nombre: string; apellidoPaterno: string; apellidoMaterno: string | null; fechaNacimiento?: Date | null } | null }>(c: T) {
  return { ...c, paciente: c.paciente ? { id: c.paciente.id, nombreCompleto: nombreCompleto(c.paciente), fechaNacimiento: c.paciente.fechaNacimiento ?? null } : null };
}

/** Valida que los vínculos de la cita sean de la empresa. Devuelve el mensaje de error o null. */
export async function validarVinculosCita(
  db: Db,
  companyId: string,
  d: { recursoId?: string; pacienteId?: string | null; medicoId?: string | null; anestesiologoId?: string | null; camaId?: string | null; servicioId?: string | null; episodioId?: string | null; cotizacionId?: string | null }
): Promise<{ error: string } | { error: null; recurso: { id: string; nombre: string; tipo: string } | null; pacienteNombre: string | null }> {
  let recurso: { id: string; nombre: string; tipo: string } | null = null;
  if (d.recursoId) {
    const r = await db.hospRecurso.findUnique({ where: { id: d.recursoId }, select: { id: true, companyId: true, nombre: true, tipo: true, activo: true } });
    if (!r || r.companyId !== companyId) return { error: "recursoId inválido" };
    if (!r.activo) return { error: `${r.nombre} está dado de baja` };
    recurso = r;
  }
  let pacienteNombre: string | null = null;
  if (d.pacienteId) {
    const p = await db.hospPaciente.findUnique({ where: { id: d.pacienteId }, select: { companyId: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true } });
    if (!p || p.companyId !== companyId) return { error: "pacienteId inválido" };
    pacienteNombre = nombreCompleto(p);
  }
  if (d.medicoId) {
    const m = await db.hospMedico.findUnique({ where: { id: d.medicoId }, select: { companyId: true } });
    if (!m || m.companyId !== companyId) return { error: "medicoId inválido" };
  }
  if (d.anestesiologoId) {
    const m = await db.hospMedico.findUnique({ where: { id: d.anestesiologoId }, select: { companyId: true } });
    if (!m || m.companyId !== companyId) return { error: "anestesiologoId inválido" };
  }
  if (d.camaId) {
    const c = await db.hospRecurso.findUnique({ where: { id: d.camaId }, select: { companyId: true, tipo: true } });
    if (!c || c.companyId !== companyId) return { error: "camaId inválido" };
    if (c.tipo !== "CAMA") return { error: "La habitación de la cita debe ser una cama del censo" };
  }
  if (d.servicioId) {
    const sv = await db.hospServicio.findUnique({ where: { id: d.servicioId }, select: { companyId: true } });
    if (!sv || sv.companyId !== companyId) return { error: "servicioId inválido" };
  }
  if (d.episodioId) {
    const e = await db.hospEpisodio.findUnique({ where: { id: d.episodioId }, select: { companyId: true } });
    if (!e || e.companyId !== companyId) return { error: "episodioId inválido" };
  }
  if (d.cotizacionId) {
    const c = await db.hospCotizacion.findUnique({ where: { id: d.cotizacionId }, select: { companyId: true } });
    if (!c || c.companyId !== companyId) return { error: "cotizacionId inválido" };
  }
  return { error: null, recurso, pacienteNombre };
}

/**
 * Mismo criterio que enforceHospitalAccess + requireWriter para escribir en
 * /citas: no es de sólo lectura, tiene rol de escritura y AGENDA_PROGRAMAR.
 */
export function puedeProgramarAgenda(role: string, hospitalPermisos: readonly string[] | null | undefined): boolean {
  return ["OWNER", "ADMIN", "ACCOUNTANT"].includes(role) && (hospitalPermisos ?? []).includes("AGENDA_PROGRAMAR");
}
