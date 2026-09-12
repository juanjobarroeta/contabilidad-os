import { describe, it, expect } from "vitest";
import { datosDeArchivo, errorDeTamano, leerArchivo, MAX_BYTES, nombreDeDescarga, respuestaDescarga } from "./documento-archivo";

const json = (body: unknown) => new Request("http://hub/archivo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("leerArchivo — lo que manda el satélite (JSON) y lo que manda un formulario (multipart)", () => {
  it("JSON { base64, mime, nombre }: los bytes decodificados, el MIME en minúsculas, el nombre acotado", async () => {
    const r = await leerArchivo(json({ base64: Buffer.from("INE").toString("base64"), mime: "image/JPEG", nombre: "x".repeat(300) }));
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.buffer.toString()).toBe("INE");
    expect(r.mime).toBe("image/jpeg");
    expect(r.nombre).toHaveLength(200);
  });

  it("sin base64 → 400; un MIME que no es PDF/JPG/PNG/WebP → 415", async () => {
    expect(await leerArchivo(json({ mime: "image/png" }))).toEqual({ error: expect.stringContaining("base64"), status: 400 });
    expect(await leerArchivo(json({ base64: "QQ==", mime: "text/html" }))).toMatchObject({ status: 415 });
  });

  it("multipart: el campo se llama «archivo» y el MIME sale del propio archivo", async () => {
    const fd = new FormData();
    fd.set("archivo", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "consentimiento.pdf", { type: "application/pdf" }));
    const r = await leerArchivo(new Request("http://hub/archivo", { method: "POST", body: fd }));
    expect(r).toMatchObject({ mime: "application/pdf", nombre: "consentimiento.pdf" });
    if ("error" in r) return;
    expect(r.buffer.length).toBe(4);

    const vacio = new FormData();
    expect(await leerArchivo(new Request("http://hub/archivo", { method: "POST", body: vacio }))).toMatchObject({ status: 400 });
  });
});

describe("tamaño y datos que se guardan", () => {
  it("vacío 400, más de 10 MB 413, si cabe null", () => {
    expect(errorDeTamano(Buffer.alloc(0))).toMatchObject({ status: 400 });
    expect(errorDeTamano(Buffer.alloc(MAX_BYTES + 1))).toMatchObject({ status: 413 });
    expect(errorDeTamano(Buffer.alloc(10))).toBeNull();
  });

  it("un PENDIENTE pasa a RECIBIDO al recibir su archivo; un FIRMADO no cambia de estado", () => {
    const archivo = { buffer: Buffer.from("abc"), mime: "image/png", nombre: null };
    expect(datosDeArchivo(archivo, "PENDIENTE", "u1")).toMatchObject({ estado: "RECIBIDO", mime: "image/png", bytes: 3, subidoPorUserId: "u1" });
    expect(datosDeArchivo(archivo, "FIRMADO", "u1")).not.toHaveProperty("estado");
  });
});

describe("descarga", () => {
  it("el nombre va saneado y con la extensión del MIME, sin duplicarla", () => {
    expect(nombreDeDescarga("Identificación INE", "image/jpeg")).toBe("Identificaci_n INE.jpg");
    expect(nombreDeDescarga("consentimiento.pdf", "application/pdf")).toBe("consentimiento.pdf");
    expect(nombreDeDescarga("///", "image/webp")).toBe("___.webp");
    expect(nombreDeDescarga("   ", "image/webp")).toBe("documento.webp");
  });

  it("siempre attachment, sin caché", () => {
    const r = respuestaDescarga(new Uint8Array([1, 2, 3]), "image/png", "foto");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="foto.png"');
    expect(r.headers.get("content-length")).toBe("3");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });
});
