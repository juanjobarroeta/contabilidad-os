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
