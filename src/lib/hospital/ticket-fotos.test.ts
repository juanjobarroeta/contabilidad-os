import { describe, it, expect } from "vitest";
import { MAX_BYTES_FOTO, MAX_FOTOS_TICKET, fotoResumen, validarCupo, validarFoto } from "./ticket-fotos";
import { HospitalError } from "./errores";

describe("validarFoto()", () => {
  it("acepta lo que sale de la cámara de un teléfono, ya encogido", () => {
    expect(() => validarFoto("image/jpeg", 300 * 1024)).not.toThrow();
    expect(() => validarFoto("image/png", 120 * 1024)).not.toThrow();
    expect(() => validarFoto("image/webp", 90 * 1024)).not.toThrow();
  });

  it("rechaza lo que después no se podría pintar", () => {
    // HEIC entra por la cámara de iPhone pero no lo dibuja ningún navegador:
    // aceptarlo sería guardar una foto que nadie puede ver.
    expect(() => validarFoto("image/heic", 300 * 1024)).toThrow(HospitalError);
    expect(() => validarFoto("application/pdf", 300 * 1024)).toThrow(/JPEG, PNG o WebP/i);
  });

  it("una foto vacía no es una foto", () => {
    expect(() => validarFoto("image/jpeg", 0)).toThrow(/vacía/i);
  });

  it("el tope es duro aunque el cliente prometa encoger", () => {
    expect(() => validarFoto("image/jpeg", MAX_BYTES_FOTO)).not.toThrow();
    expect(() => validarFoto("image/jpeg", MAX_BYTES_FOTO + 1)).toThrow(HospitalError);
    expect(() => validarFoto("image/jpeg", 4 * 1024 * 1024)).toThrow(/4\.0 MB y el tope es 2 MB/i);
  });
});

describe("validarCupo()", () => {
  it("una falla se explica con unas cuantas fotos, no con un álbum", () => {
    expect(() => validarCupo(MAX_FOTOS_TICKET - 1)).not.toThrow();
    expect(() => validarCupo(MAX_FOTOS_TICKET)).toThrow(HospitalError);
    expect(() => validarCupo(MAX_FOTOS_TICKET)).toThrow(/tope/i);
  });
});

describe("fotoResumen()", () => {
  it("nunca devuelve los bytes: para eso está la ruta de la imagen", () => {
    const r = fotoResumen({
      id: "f1",
      mime: "image/jpeg",
      bytes: 1234,
      nota: "la fuga",
      createdAt: new Date("2026-09-10T12:00:00Z"),
    });
    expect(r).toEqual({ id: "f1", mime: "image/jpeg", bytes: 1234, nota: "la fuga", createdAt: new Date("2026-09-10T12:00:00Z") });
    expect("archivo" in r).toBe(false);
  });
});
