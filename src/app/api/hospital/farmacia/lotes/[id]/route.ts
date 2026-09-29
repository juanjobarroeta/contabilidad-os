import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireWriter, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { errorZod } from "@/lib/hospital/http";
const schema = z.object({ bloqueado: z.boolean(), motivo: z.string().trim().min(10).max(2000) });
export const PATCH = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const d = schema.safeParse(await req.json());
  if (!d.success) return errorZod(d.error);
  const lot = await prisma.hospLote.findUnique({ where: { id } });
  if (!lot) throw new AuthzError(404, "Lote no encontrado");
  const { user, membership } = await requireWriter(lot.companyId, req);
  await requireModule(lot.companyId, "HOSPITAL", req);
  if (!d.data.bloqueado && !["OWNER", "ADMIN"].includes(membership.role)) throw new AuthzError(403, "Liberar un lote requiere un administrador y evidencia de revisión");
  const result = await prisma.$transaction(async tx => {
    const updated = await tx.hospLote.update({ where: { id }, data: { bloqueado: d.data.bloqueado, bloqueoMotivo: d.data.motivo } });
    await tx.hospControlEvento.create({ data: { companyId: lot.companyId, tipo: "LOTE_BLOQUEO", referencia: id, actorId: user.id, datos: d.data } });
    return updated;
  });
  return Response.json(result);
});
