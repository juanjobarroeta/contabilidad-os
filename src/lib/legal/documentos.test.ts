import { describe, expect, it } from "vitest";
import {
  DOCUMENTOS_CUENTA,
  MANDATO_EFIRMA,
  documentosPendientes,
  versionVigente,
} from "./documentos";

describe("documentosPendientes", () => {
  it("sin aceptaciones previas, todos los documentos de cuenta están pendientes", () => {
    const p = documentosPendientes([]);
    expect(p.map((d) => d.documento)).toEqual(["TERMINOS", "AVISO_PRIVACIDAD"]);
  });

  it("con la versión vigente aceptada no queda nada pendiente", () => {
    const p = documentosPendientes(
      DOCUMENTOS_CUENTA.map((d) => ({ documento: d.documento, version: d.version }))
    );
    expect(p).toEqual([]);
  });

  it("una aceptación de versión anterior vuelve a quedar pendiente", () => {
    const p = documentosPendientes([
      { documento: "TERMINOS", version: "2026-07-03" },
      { documento: "AVISO_PRIVACIDAD", version: versionVigente("AVISO_PRIVACIDAD") },
    ]);
    expect(p.map((d) => d.documento)).toEqual(["TERMINOS"]);
  });

  it("toma la aceptación más reciente aunque llegue desordenada", () => {
    const vigente = versionVigente("TERMINOS");
    const p = documentosPendientes([
      { documento: "TERMINOS", version: vigente },
      { documento: "TERMINOS", version: "2026-01-01" },
      { documento: "AVISO_PRIVACIDAD", version: versionVigente("AVISO_PRIVACIDAD") },
    ]);
    expect(p).toEqual([]);
  });

  it("el mandato de e.firma no forma parte del gate de cuenta", () => {
    const p = documentosPendientes(
      DOCUMENTOS_CUENTA.map((d) => ({ documento: d.documento, version: d.version }))
    );
    expect(p.some((d) => d.documento === "MANDATO_EFIRMA")).toBe(false);
    expect(versionVigente("MANDATO_EFIRMA")).toBe(MANDATO_EFIRMA.version);
  });

  it("las versiones son fechas ISO (para que la comparación lexicográfica sea cronológica)", () => {
    for (const d of [...DOCUMENTOS_CUENTA, MANDATO_EFIRMA]) {
      expect(d.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
