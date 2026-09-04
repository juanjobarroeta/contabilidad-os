// Agenda por recurso: esquema de la cita, detección de empalmes y la forma
// con la que se responde. «Se agenda sin empalmes» (lámina 7): dos citas
// vivas (ni canceladas ni no-asistió) no comparten quirófano ni un minuto.

import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { fechaSchema } from "./http";
import { horaLocal } from "./tz";
import { nombreCompleto } from "./util";

type Db = PrismaClient | Prisma.TransactionClient;

export const CITA_TIPOS = ["CIRUGIA", "CONSULTA", "PROCEDIMIENTO", "ESTUDIO", "OTRO"] as const;
export const CITA_ESTADOS = ["PROGRAMADA", "CONFIRMADA", "EN_CURSO", "TERMINADA", "CANCELADA", "NO_ASISTIO"] as const;

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
});

export const incluyeCita = {
  recurso: { select: { id: true, tipo: true, area: true, nombre: true } },
  paciente: { select: { id: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true } },
  medico: { select: { id: true, nombre: true, especialidad: true } },
  episodio: { select: { id: true, folio: true, estado: true } },
  cotizacion: { select: { id: true, folio: true, estado: true } },
} as const;

/** La cita viva que se cruza con [inicio, fin) en el recurso, si la hay. */
export async function citaEmpalmada(
  db: Db,
  args: { recursoId: string; inicio: Date; fin: Date; excluirId?: string | null }
) {
  return db.hospCita.findFirst({
    where: {
      recursoId: args.recursoId,
      ...(args.excluirId ? { id: { not: args.excluirId } } : {}),
      estado: { notIn: ["CANCELADA", "NO_ASISTIO"] },
      inicio: { lt: args.fin },
      fin: { gt: args.inicio },
    },
    select: { id: true, titulo: true, inicio: true, fin: true, pacienteNombre: true, recurso: { select: { nombre: true } } },
    orderBy: { inicio: "asc" },
  });
}

export function describirEmpalme(c: { titulo: string; inicio: Date; fin: Date; pacienteNombre: string | null; recurso: { nombre: string } }): string {
  const quien = c.pacienteNombre ? ` (${c.pacienteNombre})` : "";
  return `${c.recurso.nombre} ya tiene «${c.titulo}»${quien} de ${horaLocal(c.inicio)} a ${horaLocal(c.fin)}`;
}

export function serializarCita<T extends { paciente?: { id: string; nombre: string; apellidoPaterno: string; apellidoMaterno: string | null } | null }>(c: T) {
  return { ...c, paciente: c.paciente ? { id: c.paciente.id, nombreCompleto: nombreCompleto(c.paciente) } : null };
}

/** Valida que los vínculos de la cita sean de la empresa. Devuelve el mensaje de error o null. */
export async function validarVinculosCita(
  db: Db,
  companyId: string,
  d: { recursoId?: string; pacienteId?: string | null; medicoId?: string | null; episodioId?: string | null; cotizacionId?: string | null }
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
