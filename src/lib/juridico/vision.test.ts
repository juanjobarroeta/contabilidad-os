import { describe, expect, it } from "vitest";
import { esHeic, tipoImagen } from "./vision";

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);

describe("tipoImagen / esHeic", () => {
  it("reconoce JPEG, PNG, GIF y WebP por sus bytes; lo demás no es imagen", () => {
    expect(tipoImagen(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(tipoImagen(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe("image/png");
    expect(tipoImagen(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image/gif");
    expect(tipoImagen(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0]))).toBe("image/webp");
    expect(tipoImagen(bytes(0x25, 0x50, 0x44, 0x46))).toBeNull();
  });
  it("una foto HEIC de iPhone se detecta para avisar", () => {
    const heic = new Uint8Array([0, 0, 0, 0x18, ...Buffer.from("ftypheic"), 0, 0, 0, 0]);
    expect(esHeic(heic)).toBe(true);
    expect(esHeic(bytes(0xff, 0xd8, 0xff))).toBe(false);
  });
});
