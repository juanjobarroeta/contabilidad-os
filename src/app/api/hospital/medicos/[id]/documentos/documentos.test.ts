/** Documentos de credencialización: alta con archivo, verificar deja quién, editar lo regresa a recibido. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ creado: null as null | Record<string, unknown>, update: null as null | Record<string, unknown>, medicoUpdate: null as unknown, doc: { id: "doc1", medicoId: "m1", companyId: "c1", tipo: "SEGURO_RC", estado: "VERIFICADO" } }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    hospMedico: { findUnique: vi.fn(async () => ({ id: "m1", companyId: "c1", nombre: "Dr. Melchor" })), updateMany: vi.fn(async (a: unknown) => { estado.medicoUpdate = a; return { count: 1 } }) },
    hospMedicoDocumento: {
      create: vi.fn(async (a: { data: Record<string, unknown> }) => { estado.creado = a.data; return { id: "doc9", ...a.data } }),
      findUnique: vi.fn(async () => estado.doc),
      update: vi.fn(async (a: { data: Record<string, unknown> }) => { estado.update = a.data; return { ...estado.doc, ...a.data } }),
    },
  },
}));
vi.mock("@/lib/authz", () => {
  class AuthzError extends Error { constructor(public status: number, m: string) { super(m) } }
  return { AuthzError, requireMembership: vi.fn(async () => undefined), requireModule: vi.fn(async () => undefined), requireWriter: vi.fn(async () => ({ user: { id: "u1", name: "Karen", email: "k@h.test" } })), withAuthz: (h: (...a: unknown[]) => Promise<Response>) => h };
});
vi.mock("@/lib/audit", () => ({ registrarBitacora: vi.fn(), ipDeRequest: () => null }));

import { POST } from "./route";
import { PATCH } from "./[docId]/route";

const post = (body: unknown) => POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "m1" }) });
const patch = (body: unknown) => PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "m1", docId: "doc1" }) });

beforeEach(() => { estado.creado = null; estado.update = null; estado.medicoUpdate = null });

describe("POST documentos", () => {
  it("con archivo PDF: guarda bytes y entra RECIBIDO", async () => {
    const r = await post({ tipo: "SEGURO_RC", vigenciaHasta: "2027-03-01", base64: Buffer.from("%PDF-1.4 x").toString("base64"), mime: "application/pdf", nombreArchivo: "poliza.pdf" });
    expect(r.status).toBe(201);
    expect(estado.creado).toMatchObject({ medicoId: "m1", tipo: "SEGURO_RC", mime: "application/pdf", bytes: 10, nombreArchivo: "poliza.pdf" });
  });

  it("la cédula capturada llena la ficha si estaba vacía", async () => {
    await post({ tipo: "CEDULA_PROFESIONAL", numero: "1234567" });
    expect(estado.medicoUpdate).toEqual({ where: { id: "m1", cedula: null }, data: { cedula: "1234567" } });
  });

  it("sin archivo ni datos, o archivo que no es PDF/imagen → 400", async () => {
    expect((await post({ tipo: "INE" })).status).toBe(400);
    expect((await post({ tipo: "INE", base64: "eA==", mime: "text/plain" })).status).toBe(400);
  });
});

describe("PATCH documento", () => {
  it("verificar deja quién y cuándo", async () => {
    estado.doc.estado = "RECIBIDO";
    await patch({ estado: "VERIFICADO" });
    expect(estado.update).toMatchObject({ estado: "VERIFICADO", verificadoPorNombre: "Karen", verificadoPorUserId: "u1" });
  });

  it("cambiar la vigencia de uno verificado lo regresa a recibido", async () => {
    estado.doc.estado = "VERIFICADO";
    await patch({ vigenciaHasta: "2028-01-01" });
    expect(estado.update).toMatchObject({ estado: "RECIBIDO", verificadoPorNombre: null });
  });
});
