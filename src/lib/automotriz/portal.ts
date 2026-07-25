/**
 * Autenticación del portal de clientes de la agencia (automotriz) — clon del
 * patrón src/lib/purificadora/portal.ts. El token (audiencia automotriz:portal)
 * NUNCA pasa por requireUser/requireMembership; toda ruta
 * /api/automotriz/portal/* (salvo login) queda acotada al customerId del token.
 */

import { AuthzError } from "@/lib/authz";
import { extractBearer, verifyAutoPortalToken } from "@/lib/api-token";
import { prisma } from "@/lib/prisma";

export type AutoPortalContext = {
  accountId: string;
  companyId: string;
  customerId: string;
  email: string;
};

export async function requireAutoPortalAccount(req: Request): Promise<AutoPortalContext> {
  const token = extractBearer(req);
  if (!token) throw new AuthzError(401, "Token requerido");

  let payload;
  try {
    payload = await verifyAutoPortalToken(token);
  } catch {
    throw new AuthzError(401, "Token inválido o expirado");
  }

  const account = await prisma.autoPortalAccount.findUnique({
    where: { id: payload.sub },
    select: { id: true, companyId: true, customerId: true, email: true, activo: true },
  });
  if (!account || !account.activo) throw new AuthzError(401, "Cuenta de portal inactiva");

  const modulo = await prisma.companyModule.findUnique({
    where: { companyId_modulo: { companyId: account.companyId, modulo: "AUTOMOTRIZ" } },
  });
  if (!modulo?.habilitado) throw new AuthzError(403, "Portal no disponible");

  return {
    accountId: account.id,
    companyId: account.companyId,
    customerId: account.customerId,
    email: account.email,
  };
}
