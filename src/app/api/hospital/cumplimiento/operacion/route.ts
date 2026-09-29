import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { AuthzError, requireMembership, requireModule } from '@/lib/authz';
import { withHospital } from '@/lib/hospital/with-hospital';
import { errorZod } from '@/lib/hospital/http';
const text = z.string().trim().min(1).max(2000);
const schema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('RPBI_GENERACION'), companyId: z.string(), fecha: z.string().date(), area: text, clasificacion: text, envasado: text, almacenamiento: text, kilogramos: z.number().positive().max(100000), responsable: text }),
  z.object({ tipo: z.literal('RPBI_RECOLECCION'), companyId: z.string(), registroId: z.string(), fecha: z.string().date(), transportista: text, autorizacion: text, manifiesto: text, receptor: text }),
  z.object({ tipo: z.literal('RPBI_DISPOSICION'), companyId: z.string(), registroId: z.string(), fecha: z.string().date(), tratamiento: text, disposicion: text, evidencia: text }),
  z.object({ tipo: z.literal('RESPONSABLE_BAJA'), companyId: z.string(), fecha: z.string().date(), nombre: text, cedula: text, evidencia: text }),
  z.object({ tipo: z.literal('RESPONSABLE_AVISO'), companyId: z.string(), registroId: z.string(), fecha: z.string().date(), acuse: text }),
  z.object({ tipo: z.literal('RESPONSABLE_SUSTITUCION'), companyId: z.string(), registroId: z.string(), fecha: z.string().date(), nombre: text, cedula: text, permiso: text }),
]);
function limite(fecha: string, dias: number) { const d = new Date(`${fecha}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10); }
export const GET = withHospital(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get('companyId') ?? '';
  await requireMembership(companyId, ['OWNER', 'ADMIN'], req); await requireModule(companyId, 'HOSPITAL', req);
  const eventos = await prisma.hospControlEvento.findMany({ where: { companyId, tipo: { startsWith: 'OPERACION_' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return Response.json({ eventos });
});
export const POST = withHospital(async (req: Request) => {
  const parsed = schema.safeParse(await req.json()); if (!parsed.success) return errorZod(parsed.error);
  const { companyId, ...d } = parsed.data;
  const { user } = await requireMembership(companyId, ['OWNER', 'ADMIN'], req); await requireModule(companyId, 'HOSPITAL', req);
  const event = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`operacion:${companyId}`}))`;
    let ref = crypto.randomUUID();
    if ('registroId' in d) {
      const expected = d.tipo.startsWith('RPBI') ? 'OPERACION_RPBI_GENERACION' : 'OPERACION_RESPONSABLE_BAJA';
      const origin = await tx.hospControlEvento.findFirst({ where: { id: d.registroId, companyId, tipo: expected } });
      if (!origin) throw new AuthzError(400, 'Registro de origen inválido para esta sede y actividad');
      ref = origin.referencia;
      if (d.fecha < String((origin.datos as Record<string, unknown>).fecha)) throw new AuthzError(400, 'La fecha no puede ser anterior al registro de origen');
      if (d.tipo === 'RPBI_DISPOSICION') {
        const pickup = await tx.hospControlEvento.findFirst({ where: { companyId, referencia: ref, tipo: 'OPERACION_RPBI_RECOLECCION' } });
        if (!pickup || d.fecha < String((pickup.datos as Record<string, unknown>).fecha)) throw new AuthzError(409, 'Registra la recolección previa antes de la disposición');
      }
    }
    const datos = d.tipo === 'RESPONSABLE_BAJA' ? { ...d, avisoLimite: limite(d.fecha, 15), sustitucionLimite: limite(d.fecha, 30) } : d;
    return tx.hospControlEvento.create({ data: { companyId, referencia: ref, tipo: `OPERACION_${d.tipo}`, actorId: user.id, datos } });
  });
  return Response.json(event, { status: 201 });
});
