// ─────────────────────────────────────────────────────────────────────────────
// LAS EMPRESAS DE UNA SESIÓN DE SATÉLITE — lo que el satélite guarda al entrar.
//
// POST /api/auth/token devuelve `companies` (rol, módulos y las páginas que el
// usuario ve en cada satélite) y el satélite lo guarda para pintar su menú.
// Antes sólo se armaba al iniciar sesión: si un administrador le cambiaba el
// rol o las páginas a alguien, su menú seguía reducido hasta que cerrara
// sesión (Hospital, oct-2026: una usuaria pasó a OWNER y no veía nada nuevo).
// Ahora lo arma esta función, y la usan el login y GET /api/auth/sesion, que
// el satélite consulta para refrescar lo guardado. Una sola forma para los dos.
//
// Dos caminos de acceso, más el operador de plataforma:
//   1. CompanyMember directo — aplica allowedModules; gana en conflicto.
//   2. DespachoMember — acceso total a las empresas del despacho (o sólo a
//      companyScopes si los hay).
//   3. Operador — completa con todas las empresas activas como OWNER.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { effectiveModules } from "@/lib/module-access";

export type EmpresaDeSesion = {
  id: string;
  rfc: string;
  razonSocial: string;
  role: string;
  modulos: string[];
  /** Encajonamiento de empleados restringidos de purificadora (o null). */
  purifPuesto: string | null;
  /** Rol del satélite de construcción (bartiz), o null = sin restricción. */
  construccionRol: string | null;
  /** Páginas visibles del satélite de construcción; [] = según su rol. */
  construccionPaginas: string[];
  /** Páginas visibles del satélite automotriz; [] = todas (sin restricción). */
  automotrizPaginas: string[];
  /** Páginas visibles del satélite Hospital; [] = todas (sin restricción). */
  hospitalPaginas: string[];
  /** Páginas visibles del satélite Salamería; [] = todas (sin restricción). */
  salameriaPaginas: string[];
};

export async function empresasDeSesion(user: { id: string; esOperador: boolean }): Promise<EmpresaDeSesion[]> {
  const [memberships, despachoMembers] = await Promise.all([
    prisma.companyMember.findMany({
      where: { userId: user.id },
      select: {
        role: true,
        allowedModules: true,
        purifPuesto: true,
        construccionRol: true,
        construccionPaginas: true,
        automotrizPaginas: true,
        hospitalPaginas: true,
        salameriaPaginas: true,
        company: {
          select: {
            id: true,
            rfc: true,
            razonSocial: true,
            isActive: true,
            modules: {
              where: { habilitado: true },
              select: { modulo: true },
            },
          },
        },
      },
    }),
    prisma.despachoMember.findMany({
      where: { userId: user.id },
      select: {
        role: true,
        companyScopes: { select: { companyId: true } },
        despacho: {
          select: {
            companies: {
              select: {
                id: true,
                rfc: true,
                razonSocial: true,
                isActive: true,
                modules: {
                  where: { habilitado: true },
                  select: { modulo: true },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  const byId = new Map<string, EmpresaDeSesion>();

  // 1. Direct memberships first — they win on conflict because their role
  //    + allowedModules are the most precise scope.
  for (const m of memberships) {
    if (!m.company.isActive) continue;
    const enabled = m.company.modules.map((x) => x.modulo);
    const modulos = effectiveModules(enabled, m.allowedModules);
    if (modulos.length === 0) continue;
    byId.set(m.company.id, {
      id: m.company.id,
      rfc: m.company.rfc,
      razonSocial: m.company.razonSocial,
      role: m.role,
      modulos,
      purifPuesto: m.purifPuesto ?? null,
      construccionRol: m.construccionRol ?? null,
      construccionPaginas: m.construccionPaginas ?? [],
      automotrizPaginas: m.automotrizPaginas ?? [],
      hospitalPaginas: m.hospitalPaginas ?? [],
      salameriaPaginas: m.salameriaPaginas ?? [],
    });
  }

  // 2. Despacho-derived access — only fills in companies not already covered
  //    by a direct membership. Despacho members get full module access.
  for (const dm of despachoMembers) {
    const scopeIds = new Set(dm.companyScopes.map((s) => s.companyId));
    const scoped = scopeIds.size > 0;
    for (const c of dm.despacho.companies) {
      if (!c.isActive) continue;
      if (scoped && !scopeIds.has(c.id)) continue;
      if (byId.has(c.id)) continue; // direct membership wins
      const modulos = c.modules.map((x) => x.modulo);
      if (modulos.length === 0) continue;
      byId.set(c.id, {
        id: c.id,
        rfc: c.rfc,
        razonSocial: c.razonSocial,
        role: dm.role,
        modulos,
        purifPuesto: null, // acceso vía despacho: sin restricción de puesto
        construccionRol: null, // acceso vía despacho: sin rol restringido
        construccionPaginas: [], // acceso vía despacho: ve todas las páginas
        automotrizPaginas: [], // acceso vía despacho: ve todas las páginas
        hospitalPaginas: [], // acceso vía despacho: ve todas las páginas
        salameriaPaginas: [], // acceso vía despacho: ve todas las páginas
      });
    }
  }

  // 3. Operador de plataforma: adentro del hub ya opera TODAS las empresas
  //    activas (la guardia de membresía le da OWNER en cualquiera), pero esta
  //    lista sólo traía sus membresías directas y las de su despacho, así que
  //    un satélite le decía «ninguna de tus empresas tiene el módulo» para
  //    empresas que sí puede operar. Se completa con las que faltan.
  if (user.esOperador) {
    const todas = await prisma.company.findMany({
      where: { isActive: true },
      select: {
        id: true,
        rfc: true,
        razonSocial: true,
        modules: { where: { habilitado: true }, select: { modulo: true } },
      },
    });
    for (const c of todas) {
      if (byId.has(c.id)) continue;
      const modulos = c.modules.map((x) => x.modulo);
      if (modulos.length === 0) continue;
      byId.set(c.id, {
        id: c.id,
        rfc: c.rfc,
        razonSocial: c.razonSocial,
        role: "OWNER",
        modulos,
        purifPuesto: null,
        construccionRol: null,
        construccionPaginas: [],
        automotrizPaginas: [],
        hospitalPaginas: [],
        salameriaPaginas: [],
      });
    }
  }

  return Array.from(byId.values());
}
