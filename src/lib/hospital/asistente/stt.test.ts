import { beforeEach, describe, expect, it, vi } from "vitest";

const costo = vi.hoisted(() => ({ llamadas: [] as Array<{ segundos: number; ctx: unknown }> }));
vi.mock("@/lib/costos/record", () => ({
  recordWhisperCost: vi.fn(async (segundos: number, ctx: unknown) => {
    costo.llamadas.push({ segundos, ctx });
  }),
}));

import { CONFIG_ASISTENTE_DEFAULT, MENSAJE_IA_APAGADA, MENSAJE_STT_NAVEGADOR, MENSAJE_STT_SIN_LLAVE, errorAsistente, errorStt } from "./politica";
import { STT_MAX_BYTES, idiomaStt, mimeAudioAdmitido, transcribirAudio } from "./stt";

beforeEach(() => {
  costo.llamadas = [];
});

describe("política del asistente (409)", () => {
  const ep = { estado: "HOSPITALIZADO" as const, folio: "HOSP-2026-0418" };

  it("iaAsistencia = false apaga los endpoints", () => {
    const e = errorAsistente({ iaAsistencia: false, sttProveedor: "openai" }, ep);
    expect(e?.status).toBe(409);
    expect(e?.message).toBe(MENSAJE_IA_APAGADA);
  });

  it("sin fila de configuración aplican los defaults (encendido, navegador)", () => {
    expect(errorAsistente(null, ep)).toBeNull();
    expect(errorAsistente(undefined, ep)).toBeNull();
    expect(CONFIG_ASISTENTE_DEFAULT).toEqual({ iaAsistencia: true, sttProveedor: "navegador" });
  });

  it("un episodio cancelado no se asiste", () => {
    const e = errorAsistente({ iaAsistencia: true, sttProveedor: null }, { ...ep, estado: "CANCELADO" });
    expect(e?.status).toBe(409);
    expect(e?.message).toMatch(/HOSP-2026-0418 está cancelado/);
  });

  it("la transcripción en el servidor exige sttProveedor = openai Y la llave", () => {
    expect(errorStt({ iaAsistencia: true, sttProveedor: "navegador" }, true)?.message).toBe(MENSAJE_STT_NAVEGADOR);
    expect(errorStt(null, true)?.message).toBe(MENSAJE_STT_NAVEGADOR);
    expect(errorStt({ iaAsistencia: true, sttProveedor: "openai" }, false)?.message).toBe(MENSAJE_STT_SIN_LLAVE);
    expect(errorStt({ iaAsistencia: true, sttProveedor: " OpenAI " }, true)).toBeNull();
    expect(errorStt({ iaAsistencia: true, sttProveedor: "navegador" }, true)?.status).toBe(409);
  });
});

describe("transcribirAudio", () => {
  const audio = Buffer.from("webm-bytes-".repeat(400));
  const respuesta = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("manda multipart a OpenAI con gpt-4o-transcribe y registra el costo por segundos", async () => {
    const peticiones: Array<{ url: string; headers: Record<string, string>; form: FormData }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      peticiones.push({ url: String(url), headers: init?.headers as Record<string, string>, form: init?.body as FormData });
      return respuesta(200, { text: "  Nota postoperatoria: paciente estable.  ", usage: { type: "duration", seconds: 42 } });
    }) as typeof fetch;
    const r = await transcribirAudio(audio, "audio/webm;codecs=opus", "es-MX", { fetchImpl, apiKey: "sk-prueba", cost: { companyId: "c1", userId: "u1" } });
    expect(r).toEqual({ texto: "Nota postoperatoria: paciente estable.", duracionSeg: 42, modelo: "gpt-4o-transcribe", proveedor: "openai" });
    expect(peticiones).toHaveLength(1);
    expect(peticiones[0].url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(peticiones[0].headers.Authorization).toBe("Bearer sk-prueba");
    const form = peticiones[0].form;
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("language")).toBe("es");
    expect(form.get("response_format")).toBe("json");
    const archivo = form.get("file") as File;
    expect(archivo.name).toBe("dictado.webm");
    expect(archivo.type).toBe("audio/webm");
    expect(archivo.size).toBe(audio.byteLength);
    expect(costo.llamadas).toEqual([{ segundos: 42, ctx: { companyId: "c1", userId: "u1", subtipo: "hospital.asistente.transcribir" } }]);
  });

  it("cae a whisper-1 (verbose_json) si el modelo nuevo no está disponible", async () => {
    const modelos: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const modelo = String((init?.body as FormData).get("model"));
      modelos.push(modelo);
      if (modelo === "gpt-4o-transcribe") return respuesta(404, { error: { message: "model not found" } });
      return respuesta(200, { text: "Texto de Whisper", duration: 12.6 });
    }) as typeof fetch;
    const r = await transcribirAudio(audio, "audio/ogg", null, { fetchImpl, apiKey: "k" });
    expect(modelos).toEqual(["gpt-4o-transcribe", "whisper-1"]);
    expect(r.modelo).toBe("whisper-1");
    expect(r.duracionSeg).toBe(13);
    expect(costo.llamadas[0].segundos).toBe(12.6);
  });

  it("estima la duración por tamaño cuando el proveedor no la da", async () => {
    const fetchImpl = (async () => respuesta(200, { text: "hola" })) as typeof fetch;
    const r = await transcribirAudio(Buffer.alloc(20_000), "audio/mp4", "es", { fetchImpl, apiKey: "k" });
    expect(r.duracionSeg).toBeNull();
    expect(costo.llamadas[0].segundos).toBe(10);
  });

  it("valida antes de llamar: vacío, > 25 MB, formato, llave", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(transcribirAudio(Buffer.alloc(0), "audio/webm", null, { fetchImpl, apiKey: "k" })).rejects.toMatchObject({ status: 400 });
    await expect(transcribirAudio(Buffer.alloc(STT_MAX_BYTES + 1), "audio/webm", null, { fetchImpl, apiKey: "k" })).rejects.toMatchObject({ status: 413 });
    await expect(transcribirAudio(audio, "application/pdf", null, { fetchImpl, apiKey: "k" })).rejects.toMatchObject({ status: 415 });
    await expect(transcribirAudio(audio, "audio/webm", null, { fetchImpl, apiKey: "" })).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(costo.llamadas).toEqual([]);
  });

  it("60 s sin respuesta es 504; un error del proveedor es 502; saturado es 503; sin voz es 422", async () => {
    const timeout = (async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    }) as typeof fetch;
    await expect(transcribirAudio(audio, "audio/webm", null, { fetchImpl: timeout, apiKey: "k" })).rejects.toMatchObject({ status: 504 });
    const falla = (async () => respuesta(500, { error: "x" })) as typeof fetch;
    await expect(transcribirAudio(audio, "audio/webm", null, { fetchImpl: falla, apiKey: "k" })).rejects.toMatchObject({ status: 502 });
    const saturado = (async () => respuesta(429, { error: "x" })) as typeof fetch;
    await expect(transcribirAudio(audio, "audio/webm", null, { fetchImpl: saturado, apiKey: "k" })).rejects.toMatchObject({ status: 503 });
    const mudo = (async () => respuesta(200, { text: "   " })) as typeof fetch;
    await expect(transcribirAudio(audio, "audio/webm", null, { fetchImpl: mudo, apiKey: "k" })).rejects.toMatchObject({ status: 422 });
  });

  it("utilería", () => {
    expect(idiomaStt("es-MX")).toBe("es");
    expect(idiomaStt("EN_us")).toBe("en");
    expect(idiomaStt(null)).toBe("es");
    expect(idiomaStt("español")).toBe("es");
    expect(mimeAudioAdmitido("audio/webm;codecs=opus")).toBe(true);
    expect(mimeAudioAdmitido("audio/x-m4a")).toBe(true);
    expect(mimeAudioAdmitido("video/mp4")).toBe(false);
    expect(mimeAudioAdmitido(null)).toBe(false);
  });
});
