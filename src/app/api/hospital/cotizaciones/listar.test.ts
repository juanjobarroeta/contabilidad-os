/** GET /cotizaciones desde la agenda: las del médico o las del paciente, sin pisar la búsqueda. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ where: null as unknown }));

vi.mock("@/lib/prisma", () => ({
  prisma: { hospCotizacion: { findMany: vi.fn(async (a: { where: unknown }) => { estado.where = a.where; return [] }) } },
}));
vi.mock("@/lib/authz", () => ({
  AuthzError: class extends Error {},
  requireMembership: vi.fn(async () => undefined),
  requireModule: vi.fn(async () => undefined),
  requireWriter: vi.fn(),
  withAuthz: (h: (...a: unknown[]) => Promise<Response>) => h,
}));

import { GET } from "./route";

const listar = (qs: string) => GET(new Request(`http://x/api/hospital/cotizaciones?companyId=c1${qs}`));

beforeEach(() => { estado.where = null });

describe("GET /cotizaciones", () => {
  it("medicoId y pacienteId: una u otra", async () => {
    expect((await listar("&medicoId=m1&pacienteId=p1")).status).toBe(200);
    expect(estado.where).toEqual({ companyId: "c1", AND: [{ OR: [{ medicoId: "m1" }, { pacienteId: "p1" }] }] });
  });

  it("junto con la búsqueda no se pisan los OR", async () => {
    await listar("&medicoId=m1&q=rino");
    const w = estado.where as { AND: unknown; OR: unknown[] };
    expect(w.AND).toEqual([{ OR: [{ medicoId: "m1" }] }]);
    expect(w.OR).toHaveLength(4);
  });

  it("sin filtros, todas las de la empresa", async () => {
    await listar("");
    expect(estado.where).toEqual({ companyId: "c1" });
  });
});
