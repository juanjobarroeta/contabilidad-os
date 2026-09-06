/**
 * Las cuatro rutas /asistente/* con authz, prisma, bitácora y el modelo
 * simulados: los 409 de la política (iaAsistencia apagada, STT sin proveedor
 * o sin llave, episodio cancelado), la validación del body y que la
 * respuesta sea la propuesta tal cual la arma la librería.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  episodio: null as null | { id: string; companyId: string; folio: string; estado: string; tipo: string; pacienteId: string },
  config: null as null | { iaAsistencia: boolean; sttProveedor: string | null },
  bitacora: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    hospEpisodio: { findUnique: vi.fn(async () => estado.episodio) },
    hospConfig: { findUnique: vi.fn(async () => estado.config) },
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
    requireWriter: vi.fn(async () => ({ user: { id: "u1", email: "vega@haltus.test", name: "Dr. Alonso Vega" } })),
    requireModule: vi.fn(async () => undefined),
    withAuthz:
      (handler: (...a: unknown[]) => Promise<Response>) =>
      async (...a: unknown[]) => {
        try {
          return await handler(...a);
        } catch (e) {
          if (e instanceof AuthzError) return Response.json({ error: e.message }, { status: e.status });
          throw e;
        }
      },
  };
});

vi.mock("@/lib/audit", () => ({
  registrarBitacora: vi.fn((entrada: Record<string, unknown>) => {
    estado.bitacora.push(entrada);
  }),
  ipDeRequest: () => null,
}));

vi.mock("@/lib/ai/guardia", () => ({
  asegurarUsoIA: vi.fn(async () => ({ ok: true })),
  respuestaTopeIA: (d: { status: number; mensaje: string }) => Response.json({ error: d.mensaje }, { status: d.status }),
}));

vi.mock("@/lib/hospital/asistente/estructurar", async (importOriginal) => ({ ...(await importOriginal<object>()), estructurarNota: vi.fn() }));
vi.mock("@/lib/hospital/asistente/codificar", async (importOriginal) => ({ ...(await importOriginal<object>()), codificarEpisodio: vi.fn() }));
vi.mock("@/lib/hospital/asistente/egreso", async (importOriginal) => ({ ...(await importOriginal<object>()), proponerEgreso: vi.fn() }));
vi.mock("@/lib/hospital/asistente/stt", async (importOriginal) => ({ ...(await importOriginal<object>()), transcribirAudio: vi.fn() }));

import { estructurarNota } from "@/lib/hospital/asistente/estructurar";
import { codificarEpisodio } from "@/lib/hospital/asistente/codificar";
import { proponerEgreso } from "@/lib/hospital/asistente/egreso";
import { transcribirAudio } from "@/lib/hospital/asistente/stt";
import { MENSAJE_IA_APAGADA, MENSAJE_STT_NAVEGADOR, MENSAJE_STT_SIN_LLAVE } from "@/lib/hospital/asistente/politica";
import { POST as estructurar } from "./estructurar/route";
import { POST as codificar } from "./codificar/route";
import { POST as egreso } from "./egreso/route";
import { POST as transcribir } from "./transcribir/route";

const ctx = { params: Promise.resolve({ id: "ep1" }) };
const json = (ruta: string, body: unknown) =>
  new Request(`http://hub.test/api/hospital/episodios/ep1/asistente/${ruta}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  estado.episodio = { id: "ep1", companyId: "c1", folio: "HOSP-2026-0418", estado: "POSTOPERATORIO", tipo: "HOSPITALIZACION", pacienteId: "p1" };
  estado.config = { iaAsistencia: true, sttProveedor: "navegador" };
  estado.bitacora = [];
  vi.mocked(estructurarNota).mockReset();
  vi.mocked(codificarEpisodio).mockReset();
  vi.mocked(proponerEgreso).mockReset();
  vi.mocked(transcribirAudio).mockReset();
  delete process.env.OPENAI_API_KEY;
});

describe("409 de la política", () => {
  it("iaAsistencia = false apaga estructurar, codificar, egreso y transcribir", async () => {
    estado.config = { iaAsistencia: false, sttProveedor: "openai" };
    for (const [nombre, handler, body] of [
      ["estructurar", estructurar, { tipo: "EVOLUCION", texto: "dictado" }],
      ["codificar", codificar, {}],
      ["egreso", egreso, undefined],
    ] as const) {
      const res = await handler(json(nombre, body), ctx);
      expect(res.status, nombre).toBe(409);
      expect((await res.json()).error).toBe(MENSAJE_IA_APAGADA);
    }
    const form = new FormData();
    form.append("audio", new File([new Uint8Array(10)], "a.webm", { type: "audio/webm" }));
    const res = await transcribir(new Request("http://hub.test/x", { method: "POST", body: form }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MENSAJE_IA_APAGADA);
    expect(estructurarNota).not.toHaveBeenCalled();
    expect(transcribirAudio).not.toHaveBeenCalled();
  });

  it("transcribir: 409 con el proveedor navegador y 409 con openai sin llave", async () => {
    const form = () => {
      const f = new FormData();
      f.append("audio", new File([new Uint8Array(10)], "a.webm", { type: "audio/webm" }));
      return new Request("http://hub.test/x", { method: "POST", body: f });
    };
    let res = await transcribir(form(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MENSAJE_STT_NAVEGADOR);

    estado.config = { iaAsistencia: true, sttProveedor: "openai" };
    res = await transcribir(form(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MENSAJE_STT_SIN_LLAVE);
    expect(transcribirAudio).not.toHaveBeenCalled();
  });

  it("sin fila de HospConfig los defaults dejan pasar a estructurar", async () => {
    estado.config = null;
    vi.mocked(estructurarNota).mockResolvedValue({ tipo: "EVOLUCION", secciones: {}, faltantes: [], texto: "x", codigos: { diagnosticos: [], procedimientos: [] }, advertencias: [], asistencia: { origen: "ESTRUCTURADO", modelo: "m", at: "2026-09-05T00:00:00.000Z" }, uso: { intentos: 1, inputTokens: 1, outputTokens: 1 } });
    const res = await estructurar(json("estructurar", { tipo: "EVOLUCION", texto: "dictado" }), ctx);
    expect(res.status).toBe(200);
  });

  it("episodio cancelado o inexistente", async () => {
    estado.episodio = { ...estado.episodio!, estado: "CANCELADO" };
    let res = await egreso(json("egreso", undefined), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/cancelado/);
    estado.episodio = null;
    res = await egreso(json("egreso", undefined), ctx);
    expect(res.status).toBe(404);
  });
});

describe("estructurar", () => {
  it("valida el body (400) antes de tocar la base", async () => {
    const res = await estructurar(json("estructurar", { tipo: "NOTA_RARA", texto: "" }), ctx);
    expect(res.status).toBe(400);
    expect(estructurarNota).not.toHaveBeenCalled();
  });

  it("devuelve la propuesta y deja bitácora hospital.asistente.estructurar", async () => {
    const propuesta = {
      tipo: "EVOLUCION" as const,
      secciones: { subjetivo: "Sin dolor", objetivo: "Herida limpia", analisis: "Favorable", plan: "Alta mañana" },
      faltantes: [],
      texto: "Evoluciona bien.",
      codigos: { diagnosticos: [{ codigo: "K80.2", clave: "K802", nombre: "…", capitulo: "XI", confianza: 0.9, fragmento: "…", principal: false }], procedimientos: [] },
      advertencias: ["revisar"],
      asistencia: { origen: "ESTRUCTURADO" as const, modelo: "claude-sonnet-4-5", at: "2026-09-05T15:00:00.000Z" },
      uso: { intentos: 1, inputTokens: 10, outputTokens: 5 },
    };
    vi.mocked(estructurarNota).mockResolvedValue(propuesta);
    const res = await estructurar(json("estructurar", { tipo: "EVOLUCION", texto: "sin dolor herida limpia alta mañana", contexto: { signos: false } }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(propuesta);
    expect(vi.mocked(estructurarNota).mock.calls[0][1]).toMatchObject({ companyId: "c1", episodioId: "ep1", tipo: "EVOLUCION", userId: "u1", contexto: { signos: false } });
    expect(estado.bitacora).toEqual([
      expect.objectContaining({ accion: "hospital.asistente.estructurar", companyId: "c1", userId: "u1", entidad: "HospEpisodio", entidadId: "ep1", detalle: expect.objectContaining({ folio: "HOSP-2026-0418", tipo: "EVOLUCION", modelo: "claude-sonnet-4-5", codigos: 1, advertencias: 1 }) }),
    ]);
  });

  it("un HospitalError de la librería sale como { error } con su código", async () => {
    const { HospitalError } = await import("@/lib/hospital/errores");
    vi.mocked(estructurarNota).mockRejectedValue(new HospitalError(429, "Tope"));
    const res = await estructurar(json("estructurar", { tipo: "EVOLUCION", texto: "x" }), ctx);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Tope" });
  });
});

describe("codificar y egreso", () => {
  it("codificar acepta body vacío y pasa el texto cuando viene", async () => {
    const salida = { diagnosticos: [], procedimientos: [], causaExterna: null, advertencias: [], fuente: { origen: "NOTAS" as const, notasIncluidas: 3, notasOmitidas: 0 }, asistencia: { origen: "SUGERIDO" as const, modelo: "m", at: "2026-09-05T15:00:00.000Z" }, uso: { intentos: 1, inputTokens: 1, outputTokens: 1 } };
    vi.mocked(codificarEpisodio).mockResolvedValue(salida);
    let res = await codificar(new Request("http://hub.test/x", { method: "POST" }), ctx);
    expect(res.status).toBe(200);
    expect(vi.mocked(codificarEpisodio).mock.calls[0][1]).toMatchObject({ texto: null });
    res = await codificar(json("codificar", { texto: "Fractura de fémur" }), ctx);
    expect(res.status).toBe(200);
    expect(vi.mocked(codificarEpisodio).mock.calls[1][1]).toMatchObject({ texto: "Fractura de fémur" });
    expect(estado.bitacora.map((b) => b.accion)).toEqual(["hospital.asistente.codificar", "hospital.asistente.codificar"]);
  });

  it("egreso devuelve la propuesta completa", async () => {
    const salida = { tipo: "EGRESO" as const, secciones: { diagnosticoEgreso: "x", motivoEgreso: "Mejoría", evolucion: "y", planManejo: "z", diasEstancia: 1 }, faltantes: [], texto: "t", motivoEgresoClave: "MEJORIA" as const, aldrete: 9, diasEstancia: 1, codigos: { diagnosticos: [], procedimientos: [] }, saeh: { afeccionPrincipal: null, comorbilidades: [], procedimientos: [], causaExterna: null }, advertencias: [], notas: { incluidas: 5, omitidas: 0 }, asistencia: { origen: "SUGERIDO" as const, modelo: "m", at: "2026-09-05T15:00:00.000Z" }, uso: { intentos: 1, inputTokens: 1, outputTokens: 1 } };
    vi.mocked(proponerEgreso).mockResolvedValue(salida);
    const res = await egreso(new Request("http://hub.test/x", { method: "POST" }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(salida);
    expect(estado.bitacora[0]).toMatchObject({ accion: "hospital.asistente.egreso", detalle: expect.objectContaining({ motivoEgresoClave: "MEJORIA", notas: 5 }) });
  });
});

describe("transcribir", () => {
  it("con openai y llave manda el audio y contesta la transcripción con su asistencia", async () => {
    estado.config = { iaAsistencia: true, sttProveedor: "openai" };
    process.env.OPENAI_API_KEY = "sk-prueba";
    vi.mocked(transcribirAudio).mockResolvedValue({ texto: "Nota postoperatoria.", duracionSeg: 42, modelo: "gpt-4o-transcribe", proveedor: "openai" });
    const f = new FormData();
    f.append("audio", new File([new Uint8Array([1, 2, 3])], "dictado.webm", { type: "audio/webm" }));
    f.append("idioma", "es-MX");
    const res = await transcribir(new Request("http://hub.test/x", { method: "POST", body: f }), ctx);
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo).toMatchObject({ texto: "Nota postoperatoria.", duracionSeg: 42, proveedor: "openai", modelo: "gpt-4o-transcribe", asistencia: { origen: "DICTADO", sttProveedor: "openai", modelo: "gpt-4o-transcribe" } });
    expect(typeof cuerpo.asistencia.at).toBe("string");
    const [buffer, mime, idioma, opciones] = vi.mocked(transcribirAudio).mock.calls[0];
    expect([...buffer]).toEqual([1, 2, 3]);
    expect(mime).toBe("audio/webm");
    expect(idioma).toBe("es-MX");
    expect(opciones).toEqual({ cost: { companyId: "c1", userId: "u1", subtipo: "hospital.asistente.transcribir" } });
    expect(estado.bitacora[0]).toMatchObject({ accion: "hospital.asistente.transcribir", detalle: expect.objectContaining({ bytes: 3, modelo: "gpt-4o-transcribe" }) });
  });

  it("sin campo audio o con formato raro: 400 / 415", async () => {
    estado.config = { iaAsistencia: true, sttProveedor: "openai" };
    process.env.OPENAI_API_KEY = "sk-prueba";
    const vacio = new FormData();
    let res = await transcribir(new Request("http://hub.test/x", { method: "POST", body: vacio }), ctx);
    expect(res.status).toBe(400);
    const pdf = new FormData();
    pdf.append("audio", new File([new Uint8Array(3)], "a.pdf", { type: "application/pdf" }));
    res = await transcribir(new Request("http://hub.test/x", { method: "POST", body: pdf }), ctx);
    expect(res.status).toBe(415);
    expect(transcribirAudio).not.toHaveBeenCalled();
  });
});
