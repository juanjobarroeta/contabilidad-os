/**
 * Autenticación del portal de clientes de la purificadora.
 *
 * El token del portal (audiencia purificadora:portal) NUNCA pasa por
 * requireUser/requireMembership — la cuenta no es staff. Este helper verifica
 * el bearer, carga la cuenta y valida que siga activa y que el módulo siga
 * contratado. Toda ruta /api/purificadora/portal/* (salvo login) lo usa y
 * queda estrictamente acotada al customerId de la cuenta.
 */

import { AuthzError } from "@/lib/authz";
import { extractBearer, verifyPurifPortalToken } from "@/lib/api-token";
import { prisma } from "@/lib/prisma";

export type PortalContext = {
  accountId: string;
  companyId: string;
  customerId: string;
  email: string;
};

export async function requirePortalAccount(req: Request): Promise<PortalContext> {
  const token = extractBearer(req);
  if (!token) throw new AuthzError(401, "Token requerido");

  let payload;
  try {
    payload = await verifyPurifPortalToken(token);
  } catch {
    throw new AuthzError(401, "Token inválido o expirado");
  }

  const account = await prisma.purifPortalAccount.findUnique({
    where: { id: payload.sub },
    select: { id: true, companyId: true, customerId: true, email: true, activo: true },
  });
  if (!account || !account.activo) {
    throw new AuthzError(401, "Cuenta de portal inactiva");
  }

  const modulo = await prisma.companyModule.findUnique({
    where: { companyId_modulo: { companyId: account.companyId, modulo: "PURIFICADORA" } },
  });
  if (!modulo?.habilitado) {
    throw new AuthzError(403, "Portal no disponible");
  }

  return {
    accountId: account.id,
    companyId: account.companyId,
    customerId: account.customerId,
    email: account.email,
  };
}
