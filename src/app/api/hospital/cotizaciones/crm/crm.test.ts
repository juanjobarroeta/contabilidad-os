/** Tablero CRM: periodo + todas las abiertas, nombres del equipo para los responsables. */
import { describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ where: null as unknown }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    hospCotizacion: {
      findMany: vi.fn(async (a: { where: unknown }) => {
        estado.where = a.where;
        return [{
          id: "q1", folio: "COT-1", estado: "ENVIADA", procedimiento: "Rinoplastia", total: 23000, createdAt: new Date(2026, 9, 1), enviadaAt: new Date(2026, 9, 1), cerradaAt: null,
          vigenciaHasta: null, proximoSeguimiento: new Date(2020, 0, 1), responsableUserId: "u1", contactoTelefono: "2221234567", origen: "MEDICO", motivoPerdida: null, perdidaContra: null,
          pacienteNombre: "", dirigidaA: "A quien corresponda", paciente: null, medico: { id: "m1", nombre: "Dr. Melchor" }, seguimientos: [],
        }];
      }),
    },
    companyMember: { findMany: vi.fn(async () => [{ user: { id: "u1", name: "Karen", email: "k@h.test" } }, { user: { id: "u2", name: null, email: "ana@h.test" } }]) },
  },
}));
vi.mock("@/lib/authz", () => ({
  AuthzError: class extends Error {},
  requireMembership: vi.fn(async () => undefined),
  requireModule: vi.fn(async () => undefined),
  withAuthz: (h: (...a: unknown[]) => Promise<Response>) => h,
}));

import { GET } from "./route";

describe("GET /cotizaciones/crm", () => {
  it("lee periodo + abiertas y devuelve tablero con equipo", async () => {
    const d = await (await GET(new Request("http://x/api/hospital/cotizaciones/crm?companyId=c1&desde=2026-09-01&hasta=2026-10-31"))).json();
    const w = estado.where as { companyId: string; OR: Array<Record<string, unknown>> };
    expect(w.companyId).toBe("c1");
    expect(w.OR[1]).toEqual({ estado: { in: ["BORRADOR", "ENVIADA", "ACEPTADA"] } });
    expect(d.equipo).toEqual([{ userId: "u2", nombre: "ana@h.test" }, { userId: "u1", nombre: "Karen" }]);
    expect(d.porResponsable[0]).toMatchObject({ clave: "u1", nombre: "Karen", n: 1 });
    expect(d.porSeguir[0]).toMatchObject({ folio: "COT-1", urgencia: "VENCIDO", para: "Dr. Melchor" });
    expect(d.kpis).toMatchObject({ abiertas: 1, montoAbierto: 23000 });
  });
});
