import { describe, expect, it } from "vitest";
import { chunkLaw } from "./chunk";

const ley = (cuerpo: string) => `LEY DE PRUEBA\n\nTÍTULO I\nDISPOSICIONES GENERALES\n${cuerpo}\n`;

describe("chunkLaw — encabezados de artículo", () => {
  it("LISR: «Artículo 113-E.» y «Artículo 5.»", () => {
    const chunks = chunkLaw(ley("Artículo 5. Texto cinco.\nArtículo 113-E. Texto resico."));
    expect(chunks.map((c) => c.articulo)).toEqual(["5", "113-E"]);
  });
  it("LIVA/CFF: el ordinal «5o.-» se conserva; «1o.-A.-» se cita «1o-A»; «17-H Bis.» entero", () => {
    const chunks = chunkLaw(ley("Artículo 5o.- Texto.\nArtículo 1o.-A.- Texto.\nArtículo 1o.-B.- Texto.\nArtículo 17-H Bis. Texto.\nArtículo 32-Bis. Texto."));
    expect(chunks.map((c) => c.articulo)).toEqual(["5o", "1o-A", "1o-B", "17-H Bis", "32-Bis"]);
  });
  it("LSS/LFT: «Artículo 5 A.» se cita «5-A»", () => {
    const chunks = chunkLaw(ley("Artículo 5. Texto.\nArtículo 5 A. Texto cinco A.\nArtículo 15 B. Texto."));
    expect(chunks.map((c) => c.articulo)).toEqual(["5", "5-A", "15-B"]);
  });
  it("no confunde una referencia en prosa con un encabezado", () => {
    const chunks = chunkLaw(ley("Artículo 5. Ver el Artículo 6 de esta Ley para más.\nArtículo 6. Texto."));
    expect(chunks.map((c) => c.articulo)).toEqual(["5", "6"]);
  });
});
