import { getEffectiveCompanyMembership, requireUser } from "@/lib/authz";

export class BancosAccessError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/**
 * Acceso a estados de cuenta (subir PDF, revisar y confirmar filas). Es la
 * misma regla que el resto de Bancos: membresía efectiva (incluye despacho y
 * operador de plataforma) y escritura salvo VIEWER. Antes pasaba por el gate
 * del agente ContaBot, que niega a operadores y a cuentas con módulos
 * restringidos — y dejaba a quien sí ve Bancos sin poder revisar lo que subió.
 */
export async function requireBancosAccess(userId: string, companyId: string) {
  const member = await getEffectiveCompanyMembership(userId, companyId);
  if (!member) throw new BancosAccessError(403, "Sin acceso a esta empresa.");
  return { canWrite: member.role !== "VIEWER", role: member.role };
}

/**
 * Sesión web O bearer de satélite (HospitalOS, PurificadoraOS…), con la misma
 * forma que `auth()` para no tocar el resto de la ruta. Los permisos se siguen
 * resolviendo por empresa en cada ruta; esto sólo identifica al usuario.
 */
export async function sesionOBearer(req: Request): Promise<{ user: { id: string; email: string | null } } | null> {
  try { const u = await requireUser(req); return { user: { id: u.id, email: u.email ?? null } }; }
  catch { return null; }
}

/**
 * Escritura sobre estados de cuenta. Además de no ser VIEWER, en un hospital
 * el personal necesita el permiso FINANZAS_ESCRIBIR de su puesto (la misma
 * regla que caja, bancos y cobros en HospitalOS). Dueños y administradores, y
 * quien entra por despacho u operación de plataforma, escriben con su rol.
 */
export async function requireEscrituraBancos(userId: string, companyId: string) {
  const access = await requireBancosAccess(userId, companyId);
  if (!access.canWrite) throw new BancosAccessError(403, "Tu usuario sólo puede consultar.");
  const { prisma } = await import("@/lib/prisma");
  const hospital = await prisma.hospConfig.findUnique({ where: { companyId }, select: { id: true } });
  if (!hospital || ["OWNER", "ADMIN"].includes(access.role)) return access;
  const member = await prisma.companyMember.findUnique({ where: { userId_companyId: { userId, companyId } }, select: { hospitalPermisos: true } });
  if (member && !member.hospitalPermisos.includes("FINANZAS_ESCRIBIR")) throw new BancosAccessError(403, "Tu puesto no tiene permiso para modificar finanzas (FINANZAS_ESCRIBIR).");
  return access;
}
