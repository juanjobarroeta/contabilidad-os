/** Cotización para un médico escrito libre: se da de alta por credencializar en la misma transacción. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ creada: null as null | Record<string, unknown>, altas: [] as unknown[] }));

vi.mock("@/lib/prisma", () => {
  const tx = {
    hospCotizacion: { create: vi.fn(async (a: { data: Record<string, unknown> }) => { estado.creada = a.data; return { id: "q1", folio: "COT-1", ...a.data, partidas: [], paciente: null, pagador: null, medico: null } }) },
  };
  return {
    prisma: {
      hospConfig: { findUnique: vi.fn(async () => ({ ivaServicios: 0.16 })) },
      hospServicio: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
});
vi.mock("@/lib/hospital/folio", () => ({ siguienteFolio: vi.fn(async () => "COT-1"), conFolioUnico: (f: () => unknown) => f() }));
vi.mock("@/lib/hospital/cita-altas", () => ({
  resolverAltasCita: vi.fn(async (_tx: unknown, _c: string, d: { medicoNuevo: { nombre: string } }) => { estado.altas.push(d); return { error: null, medicoId: "mNuevo", altas: [] } }),
}));
vi.mock("@/lib/authz", () => ({
  AuthzError: class extends Error {},
  requireMembership: vi.fn(async () => undefined),
  requireWriter: vi.fn(async () => ({ user: { id: "u1", email: "a@b.test", name: "A" } })),
  requireModule: vi.fn(async () => undefined),
  withAuthz: (h: (...a: unknown[]) => Promise<Response>) => h,
}));
vi.mock("@/lib/audit", () => ({ registrarBitacora: vi.fn(), ipDeRequest: () => null }));

import { POST } from "./route";

const crear = (extra: Record<string, unknown>) =>
  POST(new Request("http://x/api/hospital/cotizaciones", {
    method: "POST",
    body: JSON.stringify({ companyId: "c1", procedimiento: "Rinoplastia primaria", partidas: [{ categoria: "QUIROFANO", descripcion: "Sala", cantidad: 1, precioUnitario: 100 }], ...extra }),
  }));

beforeEach(() => { estado.creada = null; estado.altas = [] });

describe("POST /cotizaciones con médico nuevo", () => {
  it("da de alta al médico y liga la cotización sin paciente", async () => {
    const r = await crear({ medicoNuevo: { nombre: "Dr. Gibran Melchor" }, dirigidaA: "A quien corresponda" });
    expect(r.status).toBe(201);
    expect(estado.altas).toEqual([{ medicoNuevo: { nombre: "Dr. Gibran Melchor" } }]);
    expect(estado.creada).toMatchObject({ medicoId: "mNuevo", pacienteNombre: "" });
  });

  it("con medicoId no da de alta a nadie", async () => {
    await crear({ medicoId: null, medicoNuevo: undefined, pacienteNombre: "Ana Ruiz" });
    expect(estado.altas).toHaveLength(0);
    expect(estado.creada).toMatchObject({ medicoId: null });
  });

  it("nombre muy corto → 400", async () => {
    expect((await crear({ medicoNuevo: { nombre: "Dr" } })).status).toBe(400);
  });
});
