import type { HospEpisodio, Prisma } from '@prisma/client';
import { z } from 'zod';
import { HospitalError } from './errores';
import { verificarHashNota } from './notas';

export const altaDatosSchema = z.object({
  motivoEgreso: z.enum(['CURACION', 'MEJORIA', 'TRASLADO', 'DEFUNCION', 'VOLUNTARIA', 'FUGA', 'OTRO']),
  diagnosticoEgresoCie10: z.string().min(1).max(10),
  procedimientoCie9: z.string().max(10).nullable().optional(),
  aldreteEgreso: z.number().int().min(0).max(10).nullable().optional(),
  nota: z.string().trim().min(1).max(4000), instrucciones: z.string().trim().min(1).max(8000),
});
const approvalSchema = z.object({
  episodioVersion: z.string(), medicoId: z.string(), medicoNombre: z.string(), notaId: z.string(),
  venceAt: z.string().datetime(), datos: altaDatosSchema,
});
export const TIPOS_ALTA = ['ALTA_AUTORIZACION', 'ALTA_REVOCACION', 'ALTA_EJECUTADA'];

/** Call under the episode advisory lock for any mutation. Never trust client discharge data. */
export async function consultarAlta(db: Prisma.TransactionClient, ep: Pick<HospEpisodio, 'id' | 'companyId' | 'updatedAt' | 'estado'>, ahora = new Date()) {
  const event = await db.hospControlEvento.findFirst({ where: { companyId: ep.companyId, referencia: ep.id, tipo: { in: TIPOS_ALTA } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  if (!event || event.tipo !== 'ALTA_AUTORIZACION' || ['ALTA', 'CANCELADO'].includes(ep.estado)) return null;
  const parsed = approvalSchema.safeParse(event.datos);
  if (!parsed.success) return null;
  const d = parsed.data;
  const note = await db.hospNota.findUnique({ where: { id: d.notaId }, include: { reemplazadaPor: { select: { id: true } } } });
  const vigente = d.episodioVersion === ep.updatedAt.toISOString() && new Date(d.venceAt) > ahora && !!note && note.episodioId === ep.id && note.autorUserId === event.actorId && note.medicoId === d.medicoId && !note.reemplazadaPor && verificarHashNota(note);
  return { id: event.id, autorizadoAt: event.createdAt, ...d, vigente };
}
export async function exigirAlta(db: Prisma.TransactionClient, ep: Pick<HospEpisodio, 'id' | 'companyId' | 'updatedAt' | 'estado'>, approvalId: string, ahora = new Date()) {
  const approval = await consultarAlta(db, ep, ahora);
  if (!approval?.vigente || approval.id !== approvalId) throw new HospitalError(409, 'La autorización de alta ya no está vigente. Actualiza el expediente y pide al médico que revise y autorice nuevamente el alta.');
  return approval;
}
