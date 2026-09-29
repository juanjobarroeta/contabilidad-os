import { prisma } from '@/lib/prisma';
import { AuthzError, requireMembership, requireModule } from '@/lib/authz';
import { withHospital } from '@/lib/hospital/with-hospital';
import { errorZod } from '@/lib/hospital/http';
import { registrarAcceso } from '@/lib/hospital/accesos';
import { requirePractitioner } from '@/lib/hospital/permisos';
import { gestionSchema, conservarHasta } from '@/lib/hospital/gestiones';
type Ctx = { params: Promise<{ id: string }> };
async function context(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const p = await prisma.hospPaciente.findUnique({ where: { id } });
  if (!p) throw new AuthzError(404, 'Paciente no encontrado');
  const auth = await requireMembership(p.companyId, undefined, req);
  await requireModule(p.companyId, 'HOSPITAL', req);
  return { p, ...auth };
}
export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { p, user } = await context(req, ctx);
  await registrarAcceso({ companyId: p.companyId, pacienteId: p.id, accion: 'LECTURA_FICHA', user, req });
  const [eventos, notas, signos, episodios] = await Promise.all([
    prisma.hospControlEvento.findMany({ where: { companyId: p.companyId, referencia: p.id, tipo: { startsWith: 'GESTION_' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    prisma.hospNota.aggregate({ where: { episodio: { pacienteId: p.id } }, _max: { fecha: true, createdAt: true } }),
    prisma.hospSignos.aggregate({ where: { episodio: { pacienteId: p.id } }, _max: { fecha: true } }),
    prisma.hospEpisodio.aggregate({ where: { pacienteId: p.id }, _max: { fechaIngreso: true, fechaAlta: true } }),
  ]);
  const last = new Date(Math.max(...[p.createdAt, notas._max.fecha, notas._max.createdAt, signos._max.fecha, episodios._max.fechaIngreso, episodios._max.fechaAlta].filter((d): d is Date => !!d).map(d => d.getTime())));
  const hold = eventos.find(e => e.tipo === 'GESTION_RETENCION');
  return Response.json({ eventos, retencion: { ultimoActoRegistrado: last, minimoHasta: conservarHasta(last), retencionLegal: (hold?.datos as Record<string, unknown> | undefined)?.estado === 'ACTIVA', eliminacionAutomatica: false, advertencia: 'Mínimo calculado sobre actos registrados; documentos externos pueden extenderlo. La aplicación no permite purgar expedientes.' } });
});
export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { p, user, membership } = await context(req, ctx);
  const parsed = gestionSchema.safeParse(await req.json());
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;
  if (['RESUMEN_ENTREGA', 'VOLUNTAD_ANTICIPADA'].includes(d.tipo)) await requirePractitioner(p.companyId, user.id);
  if (['RETENCION', 'ARCO_RESOLUCION', 'PRIVACIDAD_EXCEPCION'].includes(d.tipo) && !['OWNER', 'ADMIN'].includes(membership.role)) throw new AuthzError(403, 'Esta resolución requiere al responsable administrativo autorizado');
  if (d.tipo === 'PRIVACIDAD_CONSENTIMIENTO') {
    const config = await prisma.hospConfig.findUnique({ where: { companyId: p.companyId } });
    if (!config?.avisoPrivacidadUrl || config.avisoPrivacidadVersion !== d.avisoVersion) throw new AuthzError(409, 'Configura el aviso vigente y registra su versión exacta antes de documentar el consentimiento');
  }
  const event = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`gestiones:${p.id}`}))`;
    const linkedId = 'solicitudId' in d ? d.solicitudId : 'consentimientoId' in d ? d.consentimientoId : null;
    if (linkedId) {
      const expected = d.tipo === 'RESUMEN_ENTREGA' ? 'GESTION_RESUMEN_SOLICITUD' : d.tipo === 'ARCO_RESOLUCION' ? 'GESTION_ARCO_SOLICITUD' : 'GESTION_PRIVACIDAD_CONSENTIMIENTO';
      const linked = await tx.hospControlEvento.findFirst({ where: { id: linkedId, companyId: p.companyId, referencia: p.id, tipo: expected } });
      if (!linked) throw new AuthzError(400, 'La solicitud o consentimiento no corresponde a este paciente');
    }
    return tx.hospControlEvento.create({ data: { companyId: p.companyId, referencia: p.id, tipo: `GESTION_${d.tipo}`, actorId: user.id, datos: d } });
  });
  return Response.json(event, { status: 201 });
});
