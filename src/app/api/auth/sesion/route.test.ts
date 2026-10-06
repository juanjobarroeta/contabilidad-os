import { beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// El satélite refresca su lista de empresas con esta ruta: tiene que dar la
// MISMA forma que el login y reflejar el rol y las páginas de AHORA (una
// usuaria que pasa a OWNER deja de tener el menú reducido sin cerrar sesión).
// ─────────────────────────────────────────────────────────────────────────────

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  companyMember: { findMany: vi.fn() },
  despachoMember: { findMany: vi.fn() },
  company: { findMany: vi.fn() },
}));
const auth = vi.hoisted(() => ({ userId: "u1" as string | null }));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/authz", async () => {
  class AuthzError extends Error {
    constructor(public status: number, message: string) { super(message); }
  }
  return {
    AuthzError,
    requireUser: async () => {
      if (!auth.userId) throw new AuthzError(401, "Token inválido o expirado");
      return { id: auth.userId, email: "k@x.mx", name: "Karen" };
    },
    withAuthz: (h: (...a: unknown[]) => Promise<Response>) => async (...a: unknown[]) => {
      try { return await h(...a); } catch (e) {
        const err = e as { status?: number; message: string };
        return Response.json({ error: err.message }, { status: err.status ?? 500 });
      }
    },
  };
});

const empresa = (id: string, extra: Record<string, unknown> = {}) => ({
  id, rfc: `RFC${id}`, razonSocial: `Empresa ${id}`, isActive: true,
  modules: [{ modulo: "HOSPITAL" }], ...extra,
});
const req = () => new Request("https://hub.test/api/auth/sesion", { headers: { authorization: "Bearer x" } });

beforeEach(() => {
  auth.userId = "u1";
  db.user.findUnique.mockResolvedValue({ id: "u1", email: "k@x.mx", name: "Karen", esOperador: false, subscriptionStatus: "ACTIVE" });
  db.companyMember.findMany.mockResolvedValue([]);
  db.despachoMember.findMany.mockResolvedValue([]);
  db.company.findMany.mockResolvedValue([]);
});

describe("GET /api/auth/sesion", () => {
  it("devuelve el rol y las páginas de AHORA, con la forma del login", async () => {
    db.companyMember.findMany.mockResolvedValue([
      {
        role: "OWNER", allowedModules: [], purifPuesto: null, construccionRol: null, construccionPaginas: [],
        automotrizPaginas: [], hospitalPaginas: [], salameriaPaginas: [], company: empresa("c1"),
      },
    ]);
    const { GET } = await import("./route");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      user: { id: "u1", email: "k@x.mx", name: "Karen" },
      companies: [{
        id: "c1", rfc: "RFCc1", razonSocial: "Empresa c1", role: "OWNER", modulos: ["HOSPITAL"],
        purifPuesto: null, construccionRol: null, construccionPaginas: [], automotrizPaginas: [],
        hospitalPaginas: [], salameriaPaginas: [],
      }],
    });
  });

  it("la membresía directa gana sobre el despacho; el despacho respeta sus scopes", async () => {
    db.companyMember.findMany.mockResolvedValue([
      {
        role: "VIEWER", allowedModules: [], purifPuesto: null, construccionRol: null, construccionPaginas: [],
        automotrizPaginas: [], hospitalPaginas: ["caja"], salameriaPaginas: [], company: empresa("c1"),
      },
    ]);
    db.despachoMember.findMany.mockResolvedValue([
      { role: "ADMIN", companyScopes: [{ companyId: "c1" }, { companyId: "c2" }], despacho: { companies: [empresa("c1"), empresa("c2"), empresa("c3")] } },
    ]);
    const { GET } = await import("./route");
    const { companies } = await (await GET(req())).json();
    expect(companies.map((c: { id: string; role: string }) => `${c.id}:${c.role}`)).toEqual(["c1:VIEWER", "c2:ADMIN"]);
    expect(companies[0].hospitalPaginas).toEqual(["caja"]);
  });

  it("sin token: 401; cuenta cancelada: 403", async () => {
    const { GET } = await import("./route");
    auth.userId = null;
    expect((await GET(req())).status).toBe(401);
    auth.userId = "u1";
    db.user.findUnique.mockResolvedValue({ id: "u1", email: null, name: null, esOperador: false, subscriptionStatus: "CANCELED" });
    expect((await GET(req())).status).toBe(403);
  });
});
