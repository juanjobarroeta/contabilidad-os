/**
 * P0-2b — El choke point del multi-tenant, probado contra Postgres REAL.
 *
 * src/lib/authz.ts es la única muralla entre un tenant y otro (no hay RLS) y
 * hasta hoy no tenía UN solo test. Aquí se ejercita cada rama de acceso con
 * datos reales: membresía directa, capa despacho, scoping por
 * DespachoMemberCompany, operador de plataforma, pisos de rol, módulos
 * contratados y el camino bearer completo (Request con JWT firmado).
 *
 * Se corre con vitest.integration.config.ts (npm run test:db); el setup
 * bloquea cualquier base cuya URL no parezca de prueba.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Sólo se mockea el módulo de NextAuth (camino de cookie de sesión): su import
// arrastra next/server, que no resuelve bajo vitest. Aquí TODAS las llamadas
// autenticadas van por el camino bearer (Request + JWT firmado real); auth()
// devolviendo null garantiza además que ningún test pase "por accidente" con
// una sesión fantasma.
vi.mock("@/lib/auth", () => ({ auth: async () => null }));

import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  getEffectiveCompanyMembership,
  requireMembership,
  requireWriter,
  requireOwner,
  requireModule,
  empresasAccesiblesIds,
} from "@/lib/authz";
import { signApiToken } from "@/lib/api-token";

const skip = process.env.DB_TESTS_SKIP === "1";

/** Request sintético con bearer firmado — el camino real de los satélites. */
async function reqDe(userId: string): Promise<Request> {
  const token = await signApiToken({ sub: userId, email: `${userId}@test.local`, name: userId });
  return new Request("http://test.local/api/itest", {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Espera un AuthzError con el status dado; falla si no lanza o lanza otra cosa. */
async function esperaAuthz(promesa: Promise<unknown>, status: number) {
  try {
    await promesa;
  } catch (e) {
    expect(e).toBeInstanceOf(AuthzError);
    expect((e as AuthzError).status).toBe(status);
    return;
  }
  expect.fail(`Esperaba AuthzError(${status}) y la llamada resolvió sin lanzar`);
}

// IDs fijos y legibles: si un assert falla, el mensaje se entiende solo.
const U = {
  ana: "itest-user-ana", // OWNER directa de A
  beto: "itest-user-beto", // VIEWER directo de B
  carla: "itest-user-carla", // despacho ACCOUNTANT, scoped SOLO a B
  diego: "itest-user-diego", // despacho ADMIN, sin scope rows (= todas)
  elena: "itest-user-elena", // VIEWER directa de B + despacho OWNER (gana la más permisiva)
  fede: "itest-user-fede", // ACCOUNTANT directo de C, allowedModules restringido
  gaby: "itest-user-gaby", // ACCOUNTANT directa de C, allowedModules vacío (= todos)
  olga: "itest-user-olga", // esOperador
};
const E = {
  a: "itest-empresa-a", // sin despacho
  b: "itest-empresa-b", // del despacho D
  c: "itest-empresa-c", // del despacho D, con módulo CONSTRUCCION habilitado
  inactiva: "itest-empresa-inactiva", // isActive=false — el operador NO la ve
};
const DESPACHO = "itest-despacho-d";

async function limpiar() {
  // Sólo tablas que estos fixtures tocan; la BD es dedicada de prueba.
  await prisma.despachoMemberCompany.deleteMany({});
  await prisma.despachoMember.deleteMany({});
  await prisma.companyMember.deleteMany({});
  await prisma.companyModule.deleteMany({});
  await prisma.company.deleteMany({});
  await prisma.despacho.deleteMany({});
  await prisma.user.deleteMany({});
}

describe.skipIf(skip)("authz.ts contra Postgres real (P0-2b)", () => {
  beforeAll(async () => {
    await limpiar();

    await prisma.user.createMany({
      data: Object.values(U).map((id) => ({
        id,
        email: `${id}@test.local`,
        ...(id === U.olga ? { esOperador: true } : {}),
      })),
    });

    await prisma.despacho.create({ data: { id: DESPACHO, name: "Despacho D" } });

    await prisma.company.createMany({
      data: [
        { id: E.a, rfc: "ITESTAAA010101AA1", razonSocial: "Empresa A", regimenFiscal: "601", codigoPostal: "06600" },
        { id: E.b, rfc: "ITESTBBB010101BB2", razonSocial: "Empresa B", regimenFiscal: "601", codigoPostal: "06600", despachoId: DESPACHO },
        { id: E.c, rfc: "ITESTCCC010101CC3", razonSocial: "Empresa C", regimenFiscal: "601", codigoPostal: "06600", despachoId: DESPACHO },
        { id: E.inactiva, rfc: "ITESTDDD010101DD4", razonSocial: "Empresa baja", regimenFiscal: "601", codigoPostal: "06600", isActive: false },
      ],
    });

    await prisma.companyMember.createMany({
      data: [
        { userId: U.ana, companyId: E.a, role: "OWNER" },
        { userId: U.beto, companyId: E.b, role: "VIEWER" },
        { userId: U.elena, companyId: E.b, role: "VIEWER" },
        { userId: U.fede, companyId: E.c, role: "ACCOUNTANT", allowedModules: ["CONTABILIDAD"] },
        { userId: U.gaby, companyId: E.c, role: "ACCOUNTANT" },
      ],
    });

    const carlaM = await prisma.despachoMember.create({
      data: { userId: U.carla, despachoId: DESPACHO, role: "ACCOUNTANT" },
    });
    await prisma.despachoMember.create({
      data: { userId: U.diego, despachoId: DESPACHO, role: "ADMIN" },
    });
    await prisma.despachoMember.create({
      data: { userId: U.elena, despachoId: DESPACHO, role: "OWNER" },
    });
    // Carla queda restringida a B: NO debe ver C aunque sea del mismo despacho.
    await prisma.despachoMemberCompany.create({
      data: { despachoMemberId: carlaM.id, companyId: E.b },
    });

    await prisma.companyModule.createMany({
      data: [
        { companyId: E.c, modulo: "CONSTRUCCION", habilitado: true },
        { companyId: E.b, modulo: "CONSTRUCCION", habilitado: false },
      ],
    });
  });

  afterAll(async () => {
    await limpiar();
    await prisma.$disconnect();
  });

  describe("getEffectiveCompanyMembership — la pregunta central: ¿de quién es este dato?", () => {
    it("miembro directo ve su empresa con su rol", async () => {
      expect((await getEffectiveCompanyMembership(U.ana, E.a))?.role).toBe("OWNER");
      expect((await getEffectiveCompanyMembership(U.beto, E.b))?.role).toBe("VIEWER");
    });

    it("cross-tenant: miembro de A NO tiene NINGÚN acceso a B, ni al revés", async () => {
      expect(await getEffectiveCompanyMembership(U.ana, E.b)).toBeNull();
      expect(await getEffectiveCompanyMembership(U.beto, E.a)).toBeNull();
    });

    it("despacho ACCOUNTANT con scope: ve la empresa permitida, NO la hermana", async () => {
      expect((await getEffectiveCompanyMembership(U.carla, E.b))?.role).toBe("ACCOUNTANT");
      // La trampa sutil: C es del MISMO despacho, pero Carla está scoped fuera.
      expect(await getEffectiveCompanyMembership(U.carla, E.c)).toBeNull();
    });

    it("despacho ADMIN sin scope rows: todas las del despacho como ADMIN, nunca OWNER", async () => {
      expect((await getEffectiveCompanyMembership(U.diego, E.b))?.role).toBe("ADMIN");
      expect((await getEffectiveCompanyMembership(U.diego, E.c))?.role).toBe("ADMIN");
      // Y ninguna fuera del despacho:
      expect(await getEffectiveCompanyMembership(U.diego, E.a)).toBeNull();
    });

    it("doble vía: gana el rol más permisivo (VIEWER directa + despacho OWNER ⇒ ADMIN)", async () => {
      expect((await getEffectiveCompanyMembership(U.elena, E.b))?.role).toBe("ADMIN");
    });

    it("operador: OWNER sintético sobre cualquier empresa existente, null sobre id basura", async () => {
      expect((await getEffectiveCompanyMembership(U.olga, E.a))?.role).toBe("OWNER");
      expect((await getEffectiveCompanyMembership(U.olga, E.c))?.role).toBe("OWNER");
      expect(await getEffectiveCompanyMembership(U.olga, "no-existe")).toBeNull();
    });
  });

  describe("requireMembership por bearer — el camino completo de los satélites", () => {
    it("token válido + su empresa: pasa con el rol correcto", async () => {
      const r = await requireMembership(E.a, undefined, await reqDe(U.ana));
      expect(r.membership.role).toBe("OWNER");
      expect(r.user.id).toBe(U.ana);
    });

    it("token válido + empresa AJENA: 403", async () => {
      await esperaAuthz(requireMembership(E.b, undefined, await reqDe(U.ana)), 403);
    });

    it("despacho scoped fuera de la empresa: 403 también por el camino completo", async () => {
      await esperaAuthz(requireMembership(E.c, undefined, await reqDe(U.carla)), 403);
    });

    it("piso de rol: VIEWER no pasa requireWriter", async () => {
      await esperaAuthz(requireWriter(E.b, await reqDe(U.beto)), 403);
    });

    it("requireOwner exige OWNER real: el ADMIN efectivo por despacho no basta", async () => {
      await esperaAuthz(requireOwner(E.b, await reqDe(U.elena)), 403);
    });

    it("operador pasa requireOwner en cualquier empresa; empresa inexistente da 404", async () => {
      const r = await requireOwner(E.b, await reqDe(U.olga));
      expect(r.membership.role).toBe("OWNER");
      await esperaAuthz(requireMembership("no-existe", undefined, await reqDe(U.olga)), 404);
    });

    it("token basura: 401, nunca fallback silencioso a otra identidad", async () => {
      const req = new Request("http://test.local/api/itest", {
        headers: { authorization: "Bearer no.es.un.jwt" },
      });
      await esperaAuthz(requireMembership(E.a, undefined, req), 401);
    });
  });

  describe("requireModule — módulo contratado y restricción por usuario", () => {
    it("módulo no contratado: 403; contratado pero deshabilitado: 403", async () => {
      await esperaAuthz(requireModule(E.a, "CONSTRUCCION"), 403);
      await esperaAuthz(requireModule(E.b, "CONSTRUCCION"), 403);
    });

    it("contratado y habilitado: pasa a nivel empresa (sin req)", async () => {
      const row = await requireModule(E.c, "CONSTRUCCION");
      expect(row.habilitado).toBe(true);
    });

    it("allowedModules restringido bloquea; vacío permite", async () => {
      await esperaAuthz(requireModule(E.c, "CONSTRUCCION", await reqDe(U.fede)), 403);
      expect((await requireModule(E.c, "CONSTRUCCION", await reqDe(U.gaby))).habilitado).toBe(true);
    });

    it("acceso por despacho y operador brincan la restricción por usuario", async () => {
      expect((await requireModule(E.c, "CONSTRUCCION", await reqDe(U.diego))).habilitado).toBe(true);
      expect((await requireModule(E.c, "CONSTRUCCION", await reqDe(U.olga))).habilitado).toBe(true);
    });
  });

  describe("empresasAccesiblesIds — lo que alimenta los cockpits multi-RFC", () => {
    it("miembro directo: exactamente su empresa", async () => {
      expect(await empresasAccesiblesIds(U.ana)).toEqual([E.a]);
    });

    it("despacho scoped: sólo la permitida; sin scope: todas las del despacho", async () => {
      expect(await empresasAccesiblesIds(U.carla)).toEqual([E.b]);
      expect((await empresasAccesiblesIds(U.diego)).sort()).toEqual([E.b, E.c].sort());
    });

    it("operador: todas las ACTIVAS — la empresa dada de baja no aparece", async () => {
      const ids = await empresasAccesiblesIds(U.olga);
      expect(ids.sort()).toEqual([E.a, E.b, E.c].sort());
      expect(ids).not.toContain(E.inactiva);
    });
  });
});
