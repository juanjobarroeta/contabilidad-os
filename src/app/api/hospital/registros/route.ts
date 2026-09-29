import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireMembership, requireModule } from '@/lib/authz';
import { withHospital } from '@/lib/hospital/with-hospital';
import { errorZod } from '@/lib/hospital/http';
import { registrarAcceso } from '@/lib/hospital/accesos';
import { fechaLocal } from '@/lib/hospital/tz';
const schema = z.object({ companyId: z.string().min(1), fecha: z.string().date(), page: z.coerce.number().int().min(1).max(100000).default(1) });
export const GET = withHospital(async (req: Request) => {
  const parsed = schema.safeParse(Object.fromEntries(new URL(req.url).searchParams)); if (!parsed.success) return errorZod(parsed.error);
  const { companyId, fecha, page } = parsed.data;
  const { user } = await requireMembership(companyId, undefined, req); await requireModule(companyId, 'HOSPITAL', req);
  await registrarAcceso({ companyId, accion: 'EXPORTACION', user, req, detalle: `Registro diario ${fecha}` });
  const [y, m, d] = fecha.split('-').map(Number), from = fechaLocal(y, m, d), to = fechaLocal(y, m, d + 1);
  const where = { companyId, fechaIngreso: { gte: from, lt: to } };
  const [total, episodios] = await Promise.all([
    prisma.hospEpisodio.count({ where }),
    prisma.hospEpisodio.findMany({ where, orderBy: [{ fechaIngreso: 'asc' }, { id: 'asc' }], skip: (page - 1) * 50, take: 50, select: { id: true, folio: true, tipo: true, fechaIngreso: true, estado: true, paciente: { select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true, expedienteNumero: true } }, medico: { select: { nombre: true, cedula: true } }, documentos: { where: { tipo: { in: ['ESTUDIO', 'RESULTADO'] } }, select: { id: true, tipo: true, nombre: true, estado: true, createdAt: true } } } }),
  ]);
  const auxWhere = { companyId, tipo: { in: ['ESTUDIO', 'RESULTADO'] as ('ESTUDIO' | 'RESULTADO')[] }, createdAt: { gte: from, lt: to } };
  const [totalAuxiliares, auxiliares] = await Promise.all([
    prisma.hospDocumento.count({ where: auxWhere }),
    prisma.hospDocumento.findMany({ where: auxWhere, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * 50, take: 50, select: { id: true, tipo: true, nombre: true, estado: true, createdAt: true, episodioId: true, paciente: { select: { nombre: true, apellidoPaterno: true, expedienteNumero: true } } } }),
  ]);
  return Response.json({ fecha, page, pageSize: 50, total, episodios, totalAuxiliares, auxiliares, alcance: 'Ingresos del día local y documentos auxiliares registrados ese día, incluso de ingresos previos. No incluye actividad externa no capturada.' });
});
