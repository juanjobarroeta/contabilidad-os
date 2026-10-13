/** Importar tablas de cotización: vista previa sin escribir, y al aplicar crea sólo lo nuevo con precio de referencia sin IVA. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

const estado = vi.hoisted(() => ({ creados: [] as Array<Record<string, unknown>>, existentes: [] as Array<{ clave: string }> }));

vi.mock("@/lib/prisma", () => {
  const prisma = {
    hospServicio: { findMany: vi.fn(async () => [{ id: "qx", clave: "QX01", nombre: "Sala de quirófano por hora", categoria: "QUIROFANO", precioLista: 3689.84, ivaTasa: 0.16 }]) },
    hospConfig: { findUnique: vi.fn(async () => ({ ivaServicios: 0.16 })) },
    hospProtocolo: {
      findMany: vi.fn(async () => estado.existentes),
      create: vi.fn((a: { data: Record<string, unknown> }) => { estado.creados.push(a.data); return Promise.resolve({ id: "p1", clave: a.data.clave, nombre: a.data.nombre }) }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { prisma };
});
vi.mock("@/lib/authz", () => ({
  AuthzError: class extends Error {},
  requireMembership: vi.fn(async () => ({ user: { id: "u1" } })),
  requireWriter: vi.fn(async () => ({ user: { id: "u1", email: "a@b.test", name: "A" } })),
  requireModule: vi.fn(async () => undefined),
  withAuthz: (h: (...a: unknown[]) => Promise<Response>) => h,
}));
vi.mock("@/lib/audit", () => ({ registrarBitacora: vi.fn(), ipDeRequest: () => null }));

import { POST } from "./route";

const _ = null;
function libro() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    [_, "PROCEDIMIENTO: RINOPLASTIA PRIMARIA"],
    [_, "DESCRIPCIÓN", "CANTIDAD", "PRECIO", "IMPORTE"],
    [_, "Sala de quirófano por hora", 1, 4280.21, 4280.21],
    [_, "INSUMOS"],
    [_, "Jeringa desechable 10ml", 2, 24.36, 48.72],
    [_, _, _, "TOTAL C/IVA", 4328.93],
    [_, _, _, "PAQUETE", 18000],
  ]), "Rinoplastia");
  return new Blob([XLSX.write(wb, { type: "buffer", bookType: "xlsx" })]);
}
const importar = (extra: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.set("archivo", libro(), "tablas.xlsx");
  fd.set("companyId", "c1");
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return POST(new Request("http://x/api/hospital/protocolos/importar", { method: "POST", body: fd }));
};

beforeEach(() => { estado.creados = []; estado.existentes = [] });

describe("POST /protocolos/importar", () => {
  it("vista previa: lee, empareja y no escribe", async () => {
    const r = await importar();
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(estado.creados).toHaveLength(0);
    expect(d.protocolos[0]).toMatchObject({ clave: "RINOPLASTIA", nombre: "Rinoplastia primaria", accion: "CREAR", precioPaquete: 18000, emparejadas: 1 });
    expect(d.protocolos[0].partidas.map((p: { servicioId: string | null; precioReferencia: number | null }) => [p.servicioId, p.precioReferencia])).toEqual([["qx", null], [null, 21]]);
  });

  it("aplicar crea con precio del paquete y la referencia sin IVA; lo que ya existe no se toca", async () => {
    await importar({ aplicar: "1" });
    expect(estado.creados[0]).toMatchObject({ clave: "RINOPLASTIA", precioPaquete: 18000, quirofanoMinutos: 60 });
    expect((estado.creados[0].partidas as { create: unknown[] }).create).toEqual([
      { orden: 0, servicioId: "qx", categoria: "QUIROFANO", descripcion: "Sala de quirófano por hora", cantidad: 1, opcional: false, precioReferencia: null },
      { orden: 1, servicioId: null, categoria: "MATERIAL", descripcion: "Jeringa desechable 10ml", cantidad: 2, opcional: false, precioReferencia: 21 },
    ]);
    estado.creados = []; estado.existentes = [{ clave: "RINOPLASTIA" }];
    const d = await (await importar({ aplicar: "1" })).json();
    expect(estado.creados).toHaveLength(0);
    expect(d.protocolos[0].accion).toBe("EXISTE");
  });

  it("omitir deja fuera la clave", async () => {
    await importar({ aplicar: "1", omitir: "rinoplastia" });
    expect(estado.creados).toHaveLength(0);
  });
});
