/** Estado con bitácora comercial y seguimiento: perder pide motivo, enviar agenda la primera llamada. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  cot: { id: "q1", companyId: "c1", folio: "COT-1", estado: "BORRADOR", pagadorId: null, total: 100, precioPaquete: null, enviadaAt: null as Date | null, proximoSeguimiento: null as Date | null },
  update: null as null | Record<string, unknown>,
  seguimientos: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/prisma", () => {
  const db = {
    hospCotizacion: {
      findUnique: vi.fn(async () => estado.cot),
      update: vi.fn(async (a: { data: Record<string, unknown> }) => { estado.update = a.data; return { ...estado.cot, ...a.data, partidas: [] } }),
    },
    hospCotizacionSeguimiento: { create: vi.fn(async (a: { data: Record<string, unknown> }) => { estado.seguimientos.push(a.data); return { id: "s1", ...a.data } }) },
    $transaction: vi.fn(async (x: unknown) => (typeof x === "function" ? (x as (t: unknown) => unknown)(db) : Promise.all(x as Promise<unknown>[]))),
  };
  return { prisma: db };
});
vi.mock("@/lib/authz", () => {
  class AuthzError extends Error { constructor(public status: number, m: string) { super(m) } }
  return {
    AuthzError,
    requireMembership: vi.fn(async () => undefined),
    requireWriter: vi.fn(async () => ({ user: { id: "u1", email: "karen@haltus.test", name: "Karen" } })),
    requireModule: vi.fn(async () => undefined),
    withAuthz: (h: (...a: unknown[]) => Promise<Response>) => h,
  };
});
vi.mock("@/lib/audit", () => ({ registrarBitacora: vi.fn(), ipDeRequest: () => null }));

import { PATCH } from "./route";
import { POST as SEGUIR } from "./seguimientos/route";

const ctx = { params: Promise.resolve({ id: "q1" }) };
const patch = (body: unknown) => PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }), ctx);
const seguir = (body: unknown) => SEGUIR(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), ctx);

beforeEach(() => {
  estado.cot = { ...estado.cot, estado: "BORRADOR", enviadaAt: null, proximoSeguimiento: null };
  estado.update = null;
  estado.seguimientos = [];
});

describe("PATCH estado", () => {
  it("enviar pone enviadaAt y la primera llamada a 2 días, y queda en la bitácora", async () => {
    expect((await patch({ action: "estado", estado: "ENVIADA" })).status).toBe(200);
    expect(estado.update).toMatchObject({ estado: "ENVIADA", cerradaAt: null });
    const dias = ((estado.update!.proximoSeguimiento as Date).getTime() - (estado.update!.enviadaAt as Date).getTime()) / 86_400_000;
    expect(dias).toBe(2);
    expect(estado.seguimientos[0]).toMatchObject({ tipo: "ESTADO", resultado: "ENVIADA", userNombre: "Karen", nota: "BORRADOR → ENVIADA" });
  });

  it("perder exige motivo; con motivo cierra y quita el seguimiento", async () => {
    estado.cot.estado = "ENVIADA";
    expect((await patch({ action: "estado", estado: "PERDIDA" })).status).toBe(400);
    expect((await patch({ action: "estado", estado: "PERDIDA", motivoPerdida: "OTRO_HOSPITAL", perdidaContra: "Hospital Ángeles" })).status).toBe(200);
    expect(estado.update).toMatchObject({ estado: "PERDIDA", motivoPerdida: "OTRO_HOSPITAL", perdidaContra: "Hospital Ángeles", proximoSeguimiento: null });
    expect(estado.update!.cerradaAt).toBeInstanceOf(Date);
  });

  it("una perdida se reabre como enviada y limpia el motivo", async () => {
    estado.cot.estado = "PERDIDA";
    estado.cot.enviadaAt = new Date(2026, 0, 1);
    await patch({ action: "estado", estado: "ENVIADA" });
    expect(estado.update).toMatchObject({ estado: "ENVIADA", motivoPerdida: null, cerradaAt: null });
    expect(estado.update!.enviadaAt).toBeUndefined();
  });
});

describe("POST seguimientos", () => {
  it("registra la llamada y mueve el próximo seguimiento", async () => {
    estado.cot.estado = "ENVIADA";
    const r = await seguir({ tipo: "LLAMADA", resultado: "LO_PENSARA", nota: "Habla con su esposo", proximoSeguimiento: "2026-10-20" });
    expect(r.status).toBe(201);
    expect(estado.seguimientos[0]).toMatchObject({ tipo: "LLAMADA", resultado: "LO_PENSARA", nota: "Habla con su esposo", userId: "u1" });
    expect(estado.update!.proximoSeguimiento).toBeInstanceOf(Date);
  });

  it("vacío → 400; cerrada no agenda → 409", async () => {
    expect((await seguir({ tipo: "NOTA" })).status).toBe(400);
    estado.cot.estado = "PERDIDA";
    expect((await seguir({ tipo: "NOTA", nota: "x", proximoSeguimiento: "2026-10-20" })).status).toBe(409);
  });
});
