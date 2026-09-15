import { describe, expect, it } from "vitest";
import { esAudio, segundosAproximados } from "./voz";

describe("notas de voz", () => {
  it("reconoce el audio por tipo y, si el tipo viene vacío, por la extensión", () => {
    expect(esAudio("audio/ogg; codecs=opus")).toBe(true);
    expect(esAudio("audio/mp4")).toBe(true);
    expect(esAudio("audio/webm")).toBe(true);
    // Safari en iPhone manda m4a a veces sin tipo.
    expect(esAudio("", "nota.m4a")).toBe(true);
    expect(esAudio(null, "dictado.ogg")).toBe(true);
    expect(esAudio("application/pdf", "contrato.pdf")).toBe(false);
    expect(esAudio("image/jpeg", "foto.jpg")).toBe(false);
  });

  it("estima los segundos por tamaño: Whisper cobra por minuto y no dice cuánto duró", () => {
    expect(segundosAproximados(2000)).toBe(1);
    expect(segundosAproximados(120_000)).toBe(60);
    expect(segundosAproximados(1)).toBe(1);
  });
});
