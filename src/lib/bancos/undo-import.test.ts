import { describe, it, expect } from "vitest";
import { esIntencionDeshacer } from "./undo-import";

describe("esIntencionDeshacer", () => {
  it("reconoce las frases naturales para deshacer una importación", () => {
    for (const t of [
      "deshacer la última importación",
      "deshaz la importación",
      "revierte los movimientos que subí",
      "quiero deshacer lo que subí",
      "revertir la subida del estado de cuenta",
      "borra... no, mejor deshaz la importación",
    ]) {
      expect(esIntencionDeshacer(t)).toBe(true);
    }
  });

  it("NO se dispara con otras reversiones ni con mensajes normales", () => {
    for (const t of [
      "deshacer la conciliación", // otra acción — sin importación/movimientos
      "quiero conciliar movimientos", // no hay verbo de reversión
      "revierte la factura", // reversión de otra cosa
      "cuánto llevo de gastos",
      "sube mi estado de cuenta", // subir, no deshacer
    ]) {
      expect(esIntencionDeshacer(t)).toBe(false);
    }
  });
});
