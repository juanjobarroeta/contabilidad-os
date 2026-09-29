import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { errorZod } from "@/lib/hospital/http";
import { OBLIGACIONES, estadoObligacion } from "@/lib/hospital/cumplimiento";
const schema = z.object({
  companyId: z.string().min(1), clave: z.string().refine(k => OBLIGACIONES.some(o => o[0] === k)),
  version: z.string().nullable(), estado: z.enum(["PENDIENTE", "EN_REVISION", "VERIFICADO", "NO_APLICA"]),
  responsable: z.string().trim().min(3).max(160), evidencia: z.string().trim().min(10).max(6000),
  vence: z.string().date().nullable(), siguienteRevision: z.string().date(),
});
export const GET = withHospital(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId") ?? "";
  await requireMembership(companyId, ["OWNER", "ADMIN"], req);
  await requireModule(companyId, "HOSPITAL", req);
  const events = await prisma.hospControlEvento.findMany({ where: { companyId, tipo: "CUMPLIMIENTO" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return Response.json({ consultadoAt: new Date(), obligaciones: OBLIGACIONES.map(([clave, titulo, area, requiere]) => {
    const history = events.filter(e => e.referencia === clave);
    const ultimo = history[0];
    return { clave, titulo, area, requiere, estado: estadoObligacion(ultimo?.datos as Record<string, unknown> | undefined), ultimo: ultimo ?? null, historial: history };
  }) });
});
export const POST = withHospital(async (req: Request) => {
  const d = schema.safeParse(await req.json());
  if (!d.success) return errorZod(d.error);
  const { companyId, clave, version, ...datos } = d.data;
  const { user } = await requireMembership(companyId, ["OWNER", "ADMIN"], req);
  await requireModule(companyId, "HOSPITAL", req);
  const event = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cumplimiento:${companyId}:${clave}`}))`;
    const prior = await tx.hospControlEvento.findFirst({ where: { companyId, tipo: "CUMPLIMIENTO", referencia: clave }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if ((prior?.id ?? null) !== version) throw new AuthzError(409, "Otro usuario actualizó la evidencia; recarga antes de guardar");
    if (["VERIFICADO", "NO_APLICA"].includes(datos.estado)) {
      if (!prior || prior.actorId === user.id || (prior.datos as Record<string, unknown>).estado !== "EN_REVISION") throw new AuthzError(409, "Se requiere evidencia en revisión y un segundo administrador para verificar o resolver no aplicabilidad");
      if ((prior.datos as Record<string, unknown>).evidencia !== datos.evidencia) throw new AuthzError(409, "La evidencia cambió; envía la nueva versión a revisión");
    }
    return tx.hospControlEvento.create({ data: { companyId, tipo: "CUMPLIMIENTO", referencia: clave, actorId: user.id, datos } });
  });
  return Response.json(event, { status: 201 });
});
