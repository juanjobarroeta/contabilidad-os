import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { combinarPermisos, PERMISOS_CLINICOS } from "@/lib/hospital/permisos";
import { errorZod } from "@/lib/hospital/http";

// PATCH /api/hospital/usuarios/[id]/clinica
//   { permisos, grupo?: "clinicos" | "operacion", medicoId?: string | null, evidencia? }
//
// `grupo` reemplaza sólo esas llaves (Usuarios guarda lo clínico y lo de
// operación por separado). `medicoId` ausente = no tocar la identidad médica;
// el mismo profesional que ya está vinculado y verificado se conserva sin
// volver a verificarlo (no pide evidencia ni otro administrador). Sólo un
// profesional DISTINTO pasa por la verificación completa; null la revoca.
const schema = z.object({
  permisos: z.array(z.enum(PERMISOS_CLINICOS)),
  grupo: z.enum(["clinicos", "operacion"]).optional(),
  medicoId: z.string().nullable().optional(),
  evidencia: z.string().trim().min(10).max(2000).optional(),
});

export const PATCH = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const d = schema.safeParse(await req.json());
  if (!d.success) return errorZod(d.error);
  const target = await prisma.companyMember.findUnique({ where: { id } });
  if (!target) throw new AuthzError(404, "Membresía no encontrada");
  const { user, membership } = await requireMembership(target.companyId, ["OWNER", "ADMIN"], req);
  await requireModule(target.companyId, "HOSPITAL", req);
  const permisos = combinarPermisos(target.hospitalPermisos, d.data.permisos, d.data.grupo);
  if (["OWNER", "ADMIN"].includes(target.role) && membership.role !== "OWNER" && [...permisos].sort().join() !== [...target.hospitalPermisos].sort().join()) throw new AuthzError(403, "Sólo el dueño administra los permisos de dirección");
  if (target.role === "VIEWER" && permisos.some(p => p !== "CLINICA_LEER")) throw new AuthzError(400, "Sólo lectura: no puede recibir permisos de escritura");
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`credenciales:${target.companyId}`}))`;
    const vigente = await tx.hospMedico.findFirst({ where: { companyId: target.companyId, userId: target.userId }, select: { id: true, credencialVerificadaAt: true } });
    const sinCambio = d.data.medicoId === undefined || (d.data.medicoId !== null && vigente?.id === d.data.medicoId && !!vigente.credencialVerificadaAt);
    if (sinCambio) {
      // La identidad médica se queda como está.
    } else if (d.data.medicoId) {
      if (target.userId === user.id) throw new AuthzError(403, "La verificación de tu credencial requiere otro administrador autorizado");
      const medico = await tx.hospMedico.findUnique({ where: { id: d.data.medicoId } });
      if (!medico || medico.companyId !== target.companyId || !medico.activo || !/^\d{6,12}$/.test(medico.cedula ?? "")) throw new AuthzError(400, "Selecciona un médico activo con cédula válida");
      if (!d.data.evidencia) throw new AuthzError(400, "Registra la referencia al documento y la verificación realizada");
      if (medico.userId && medico.userId !== target.userId) throw new AuthzError(409, "El profesional ya está vinculado a otro usuario");
      await tx.hospMedico.updateMany({ where: { companyId: target.companyId, userId: target.userId }, data: { userId: null, credencialVerificadaAt: null, credencialVerificadaPor: null, credencialEvidencia: null } });
      await tx.hospMedico.update({ where: { id: medico.id }, data: { userId: target.userId, credencialVerificadaAt: new Date(), credencialVerificadaPor: user.id, credencialEvidencia: d.data.evidencia } });
    } else {
      await tx.hospMedico.updateMany({ where: { companyId: target.companyId, userId: target.userId }, data: { userId: null, credencialVerificadaAt: null, credencialVerificadaPor: null, credencialEvidencia: null } });
    }
    await tx.companyMember.update({ where: { id }, data: { hospitalPermisos: permisos } });
    await tx.hospControlEvento.create({ data: { companyId: target.companyId, tipo: "CREDENCIAL_Y_PERMISOS", referencia: target.userId, actorId: user.id, datos: { ...d.data, permisos, identidadSinCambio: sinCambio } } });
  });
  return Response.json({ ok: true, permisos });
});
