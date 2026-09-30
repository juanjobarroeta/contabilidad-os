import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule } from "@/lib/authz";
import { requirePractitioner } from "@/lib/hospital/permisos";
import { withHospital } from "@/lib/hospital/with-hospital";
import { errorZod } from "@/lib/hospital/http";
import { registrarAcceso } from "@/lib/hospital/accesos";
const schema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("PREPARACION"), identidad: z.literal(true), procedimiento: z.literal(true), alergias: z.literal(true), nota: z.string().trim().min(10).max(3000) }),
  z.object({ tipo: z.literal("URGENCIA_QUIRURGICA"), solicitudId: z.string().uuid(), pacienteNoPuedeConsentir: z.literal(true), representanteNoDisponible: z.literal(true), riesgoDemora: z.string().trim().min(20).max(3000), seguimiento: z.string().trim().min(10).max(2000) }),
]);
type Ctx = { params: Promise<{ id: string }> };
async function context(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ep = await prisma.hospEpisodio.findUnique({ where: { id } });
  if (!ep) throw new AuthzError(404, "Episodio no encontrado");
  const { user } = await requireMembership(ep.companyId, undefined, req);
  await requireModule(ep.companyId, "HOSPITAL", req);
  return { ep, user };
}
export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { ep, user } = await context(req, ctx);
  await registrarAcceso({ companyId: ep.companyId, episodioId: ep.id, accion: "LECTURA_EXPEDIENTE", user, req });
  return Response.json(await prisma.hospControlEvento.findMany({ where: { companyId: ep.companyId, referencia: ep.id, tipo: { in: ["PREPARACION", "URGENCIA_QUIRURGICA", "INGRESO_QUIROFANO"] } }, orderBy: { createdAt: "desc" }, take: 100 }));
});
export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { ep, user } = await context(req, ctx);
  const medico = await requirePractitioner(ep.companyId, user.id, undefined, ep.pacienteId);
  const d = schema.safeParse(await req.json());
  if (!d.success) return errorZod(d.error);
  if (medico.soloDemostracion && d.data.tipo === "URGENCIA_QUIRURGICA") throw new AuthzError(403, "La excepción de urgencia requiere dos médicos con identidad profesional verificada. En la demostración utiliza la preparación ordinaria.");
  if (!["PREOPERATORIO", "EN_VALORACION", "HOSPITALIZADO"].includes(ep.estado)) throw new AuthzError(409, "La preparación se registra antes del ingreso a quirófano");
  const event = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`preparacion:${ep.id}`}))`;
    if (d.data.tipo === "URGENCIA_QUIRURGICA") {
      const urgencia = d.data;
      const prior = await tx.hospControlEvento.findMany({ where: { companyId: ep.companyId, referencia: ep.id, tipo: d.data.tipo } });
      const same = prior.filter(e => (e.datos as Record<string, unknown>).solicitudId === urgencia.solicitudId);
      if (same.some(e => e.actorId === user.id)) throw new AuthzError(409, "Tu atestación ya está registrada; debe intervenir un segundo médico");
      if (same.some(e => (e.datos as Record<string, unknown>).riesgoDemora !== urgencia.riesgoDemora)) throw new AuthzError(409, "Ambos médicos deben revisar el mismo motivo de urgencia");
    }
    return tx.hospControlEvento.create({ data: { companyId: ep.companyId, referencia: ep.id, tipo: d.data.tipo, actorId: user.id, datos: { ...d.data, medicoId: medico.id, cedula: medico.cedula, soloDemostracion: medico.soloDemostracion } } });
  });
  return Response.json(event, { status: 201 });
});
