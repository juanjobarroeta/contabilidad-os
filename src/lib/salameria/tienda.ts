/**
 * Autenticación de la tienda en línea — clon del patrón
 * src/lib/automotriz/portal.ts. El token (audiencia `salameria:tienda`) NUNCA
 * pasa por requireUser/requireMembership: toda ruta /api/salameria/tienda/*
 * que necesite sesión queda acotada al `cuentaId` del token.
 *
 * El catálogo y el carrito de invitado NO piden sesión — eso es el escaparate,
 * y cerrarlo con login sería cerrar la tienda. Lo que sí exige cuenta es todo
 * lo que revela precios de mayoreo, crédito o pedidos de alguien.
 */

import { AuthzError } from "@/lib/authz";
import { extractBearer, verifySalTiendaToken } from "@/lib/api-token";
import { prisma } from "@/lib/prisma";

export type SalTiendaContext = {
  cuentaId: string;
  companyId: string;
  customerId: string | null;
  listaId: string | null;
  email: string;
  diasCredito: number;
  limiteCredito: number;
};

export async function requireSalCuenta(req: Request): Promise<SalTiendaContext> {
  const token = extractBearer(req);
  if (!token) throw new AuthzError(401, "Token requerido");

  let payload;
  try {
    payload = await verifySalTiendaToken(token);
  } catch {
    throw new AuthzError(401, "Token inválido o expirado");
  }

  const cuenta = await prisma.salCuenta.findUnique({
    where: { id: payload.sub },
    select: {
      id: true,
      companyId: true,
      customerId: true,
      listaId: true,
      email: true,
      activa: true,
      diasCredito: true,
      limiteCredito: true,
    },
  });
  if (!cuenta || !cuenta.activa) throw new AuthzError(401, "Cuenta inactiva");

  // El módulo puede apagarse (fin de contrato, empresa suspendida) sin que los
  // tokens ya emitidos caduquen: se revisa en cada llamada, no sólo al entrar.
  const modulo = await prisma.companyModule.findUnique({
    where: { companyId_modulo: { companyId: cuenta.companyId, modulo: "SALAMERIA" } },
  });
  if (!modulo?.habilitado) throw new AuthzError(403, "Tienda no disponible");

  return {
    cuentaId: cuenta.id,
    companyId: cuenta.companyId,
    customerId: cuenta.customerId,
    listaId: cuenta.listaId,
    email: cuenta.email,
    diasCredito: cuenta.diasCredito,
    limiteCredito: Number(cuenta.limiteCredito),
  };
}

/**
 * La empresa dueña de la tienda pública, resuelta desde el companyId que manda
 * el escaparate. Devuelve null si no existe, no tiene el módulo o la tienda
 * está apagada — el catálogo público no debe distinguir entre esos casos.
 */
export async function tiendaPublica(companyId: string | null) {
  if (!companyId) return null;

  const [modulo, config] = await Promise.all([
    prisma.companyModule.findUnique({
      where: { companyId_modulo: { companyId, modulo: "SALAMERIA" } },
      select: { habilitado: true },
    }),
    prisma.salConfig.findUnique({ where: { companyId } }),
  ]);

  if (!modulo?.habilitado || !config?.tiendaActiva) return null;
  return config;
}
