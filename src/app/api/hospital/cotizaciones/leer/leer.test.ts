/**
 * Lectura de la cotización de otro hospital con el modelo simulado: limpia lo
 * leído, lo reprecia con la tarifa del pagador (o lista) y no escribe nada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ respuesta: "", stop: "end_turn", llamada: null as null | Record<string, unknown>, whereServicios: null as unknown }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    hospPagador: { findUnique: vi.fn(async () => ({ companyId: "c1" })) },
    hospServicio: {
      findMany: vi.fn(async (a: { where: unknown }) => {
        estado.whereServicios = a.where;
        return [
          { id: "j3", clave: "J3", nombre: "Jeringa de plástico 3 ml", categoria: "INSUMO", precioLista: 10, ivaTasa: 0.16, tarifas: [{ precio: 8 }] },
          { id: "hab", clave: "HAB", nombre: "Habitación estándar", categoria: "HOSPITALIZACION", precioLista: 2500, ivaTasa: 0.16, tarifas: [] },
        ];
      }),
    },
  },
}));

vi.mock("@/lib/authz", () => {
  class AuthzError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  return {
    AuthzError,
    requireWriter: vi.fn(async () => ({ user: { id: "u1", email: "a@b.test", name: "A" } })),
    requireModule: vi.fn(async () => undefined),
    withAuthz: (h: (...a: unknown[]) => Promise<Response>) => h,
  };
});
vi.mock("@/lib/audit", () => ({ registrarBitacora: vi.fn(), ipDeRequest: () => null }));
vi.mock("@/lib/ai/guardia", () => ({ asegurarUsoIA: vi.fn(async () => ({ ok: true })), respuestaTopeIA: vi.fn() }));
vi.mock("@/lib/costos/anthropic", () => ({
  meteredCreate: vi.fn(async (_c: unknown, _m: unknown, params: Record<string, unknown>) => {
    estado.llamada = params;
    return { stop_reason: estado.stop, content: [{ type: "text", text: estado.respuesta }] };
  }),
}));

import { POST } from "./route";

const leer = (extra: Record<string, unknown> = {}) =>
  POST(new Request("http://x/api/hospital/cotizaciones/leer", { method: "POST", body: JSON.stringify({ companyId: "c1", archivoBase64: "JVBERi0=", mime: "application/pdf", ...extra }) }));

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "x";
  estado.stop = "end_turn";
  estado.respuesta = JSON.stringify({
    procedimiento: "MIOMECTOMIA LAPAROSCOPICA SIN EQUIPO",
    total: 25700,
    totalIncluyeIva: true,
    renglones: [
      { cantidad: 3, descripcion: "JERINGA DE PLASTICO 3 ML", grupo: "INSUMOS" },
      { cantidad: 1, descripcion: "HABITACION ESTANDAR", grupo: "HOSPITALIZACION" },
      { cantidad: 1, descripcion: "KIT DE BIENVENIDA.", grupo: "SERVICIOS" },
    ],
  });
});

describe("POST /cotizaciones/leer", () => {
  it("manda el PDF como documento y reprecia con la tarifa del pagador", async () => {
    const r = await leer({ pagadorId: "pg1" });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect((estado.llamada?.messages as Array<{ content: Array<{ type: string }> }>)[0].content[0].type).toBe("document");
    expect(estado.whereServicios).toEqual({ companyId: "c1", activo: true });
    expect(d.lectura).toMatchObject({ procedimiento: "MIOMECTOMIA LAPAROSCOPICA SIN EQUIPO", total: 25700 });
    expect(d.renglones.map((x: { servicioId: string | null }) => x.servicioId)).toEqual(["j3", "hab", null]);
    // 3 × 8 (tarifa) + 2500, con IVA
    expect(d.propio).toEqual({ total: 27.84 + 2900, conPrecio: 2, sinPrecio: 1 });
    expect(d.advertencias.join(" ")).toMatch(/1 de 3 renglones/);
  });

  it("una foto va como imagen", async () => {
    await leer({ mime: "image/jpeg" });
    expect((estado.llamada?.messages as Array<{ content: Array<{ type: string }> }>)[0].content[0].type).toBe("image");
  });

  it("respuesta cortada o sin renglones → 422", async () => {
    estado.stop = "max_tokens";
    expect((await leer()).status).toBe(422);
    estado.stop = "end_turn";
    estado.respuesta = JSON.stringify({ renglones: [] });
    expect((await leer()).status).toBe(422);
  });

  it("mime no soportado → 400", async () => {
    expect((await leer({ mime: "text/plain" })).status).toBe(400);
  });
});
