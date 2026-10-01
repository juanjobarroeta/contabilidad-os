import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { idDeEntidad, refsDeArchivo, rfcDeEntidad } from "./exportar";

describe("exportar Syntage: piezas puras", () => {
  it("junta cada /files/{id} a cualquier profundidad, sin repetir", () => {
    const registros = [
      { file: { "@id": "/files/abc-1" }, acuse: "https://api.syntage.com/files/abc-1/download" },
      { files: [{ "@id": "/files/x2", filename: "BCE.xml" }, { id: "nada" }], nested: { a: [{ ref: "/files/y3" }] } },
      { texto: "sin archivo" },
    ];
    expect(refsDeArchivo(registros).sort()).toEqual(["/files/abc-1", "/files/x2", "/files/y3"]);
  });

  it("toma el id de `id` o del IRI", () => {
    expect(idDeEntidad({ id: "e1" })).toBe("e1");
    expect(idDeEntidad({ "@id": "/entities/e2" })).toBe("e2");
    expect(idDeEntidad({})).toBe("");
  });

  it("encuentra el RFC en el campo o en cualquier parte del registro", () => {
    expect(rfcDeEntidad({ rfc: "zio210815ab3" })).toBe("ZIO210815AB3");
    expect(rfcDeEntidad({ taxpayer: { id: "BAOB800101AB1" } })).toBe("BAOB800101AB1");
    expect(rfcDeEntidad({ name: "Algo", meta: { x: "RFC: AGO150704NA9" } })).toBe("AGO150704NA9");
    expect(rfcDeEntidad({ name: "Sin rfc" })).toBe("");
  });
});
