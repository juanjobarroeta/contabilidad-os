/**
 * GET /api/auth/sesion
 *
 * Lo que POST /api/auth/token devuelve al iniciar sesión —`user` y
 * `companies` (rol, módulos, páginas por satélite)—, pero leído AHORA, con el
 * mismo bearer que el satélite ya usa. Sin tokens nuevos ni efectos.
 *
 * Para qué: el satélite guarda `companies` al entrar y pinta su menú con eso.
 * Si un administrador le cambia el rol o las páginas a alguien, el menú se
 * quedaba como estaba hasta cerrar sesión. El satélite consulta esta ruta al
 * arrancar y al volver a la pestaña para refrescarlo. Los permisos los sigue
 * imponiendo cada ruta contra la base; esto sólo corrige lo que se PINTA.
 *
 * Response (200): { user: { id, email, name }, companies: [...] } — la MISMA
 * forma de `user` y `companies` que /api/auth/token (lib/empresas-sesion).
 * Errors: 401 sin token o vencido, 403 suscripción inactiva.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireUser, withAuthz } from "@/lib/authz";
import { empresasDeSesion } from "@/lib/empresas-sesion";

export const dynamic = "force-dynamic";

export const GET = withAuthz(async (req: Request) => {
  const { id } = await requireUser(req);
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, esOperador: true, subscriptionStatus: true },
  });
  if (!user) throw new AuthzError(401, "Unauthorized");
  // Misma regla que el login: una cuenta vencida o cancelada no opera.
  if (user.subscriptionStatus === "EXPIRED" || user.subscriptionStatus === "CANCELED") {
    throw new AuthzError(403, "Suscripción inactiva. Contacta soporte.");
  }
  const companies = await empresasDeSesion(user);
  return NextResponse.json(
    { user: { id: user.id, email: user.email, name: user.name }, companies },
    { headers: { "Cache-Control": "no-store" } },
  );
});
