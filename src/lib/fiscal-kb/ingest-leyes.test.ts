import { describe, expect, it } from "vitest";
import { CLAVES_LEYES, LEYES, LEYES_EXCLUIDAS, alternanciaClaves, clavesPorMateria, parseFechaVigencia } from "./ingest-leyes";

describe("parseFechaVigencia", () => {
  it("Diputados: «Última reforma publicada DOF dd-mm-aaaa»", () => {
    expect(parseFechaVigencia("LEY DEL ISR\nÚltima reforma publicada DOF 01-04-2024\nArtículo 1.")?.toISOString().slice(0, 10)).toBe("2024-04-01");
  });
  it("CDMX: «Última reforma publicada en la G.O.C.D.M.X. el 19 de diciembre de 2025»", () => {
    expect(parseFechaVigencia("CÓDIGO FISCAL DE LA CIUDAD DE MÉXICO\nÚltima reforma publicada en la G.O.C.D.M.X. el 19 DE DICIEMBRE 2025\nARTICULO 1.-")?.toISOString().slice(0, 10)).toBe("2025-12-19");
  });
  it("Orden Jurídico Poblano: la mayor fecha de la tabla de reformas", () => {
    const t = "Gobierno del Estado de Puebla\nOrden Jurídico Poblano\nREFORMAS\n6/dic/2019 DECRETO…\n5/ago/2024 DECRETO…\n30/dic/2021 DECRETO…\nARTÍCULO 1";
    expect(parseFechaVigencia(t)?.toISOString().slice(0, 10)).toBe("2024-08-05");
  });
  it("facsímil del DOF: la fecha del encabezado", () => {
    expect(parseFechaVigencia("108 (Primera Sección) DIARIO OFICIAL Viernes 10 de febrero de 2012\nREGLAMENTO de Inscripción…")?.toISOString().slice(0, 10)).toBe("2012-02-10");
  });
  it("sin fecha → null", () => {
    expect(parseFechaVigencia("Artículo 1. Nada.")).toBeNull();
  });
});

describe("catálogo de leyes", () => {
  it("es el índice federal completo más las manuales: 300+ claves, todas con materias y ámbito", () => {
    expect(Object.keys(LEYES).length).toBeGreaterThan(300);
    for (const d of Object.values(LEYES)) {
      expect(d.materias.length, d.clave).toBeGreaterThan(0);
      expect(["FEDERAL", "ESTATAL", "MUNICIPAL", "INTERNACIONAL"]).toContain(d.ambito);
      expect(d.url).toMatch(/^https:\/\//);
    }
    expect(LEYES_EXCLUIDAS.map((e) => e.clave)).toContain("PEF");
    expect(LEYES.PEF).toBeUndefined();
  });
  it("las fuentes de la Fase 1 siguen ahí, con su URL y su vigencia de respaldo", () => {
    for (const c of ["RACERF", "RIPAEDI", "CCOM", "LGSM", "LFPIORPI", "RLFPIORPI", "LFDC", "LHPUE", "CFPUE", "CFCDMX"]) expect(LEYES[c]?.clave).toBe(c);
    expect(LEYES.RIPAEDI.vigenciaFallback).toBe("2012-02-10");
    expect(LEYES.CFPUE.url).toMatch(/^https:\/\/ojp\.puebla\.gob\.mx\//);
    expect(LEYES.CFPUE.ambito).toBe("ESTATAL");
    expect(LEYES.CFPUE.entidad).toBe("PUE");
    // La LINFONAVIT conserva el PDF móvil (cambiar de PDF abriría una versión espuria por hash).
    expect(LEYES.LINFONAVIT.url).toMatch(/pdf_mov\//);
    expect(LEYES.LISR.url).toBe("https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf");
    expect(LEYES.LISR.materias).toEqual(["fiscal"]);
  });
  it("la manual gana a la generada con la misma clave, pero hereda lo que no redefine", () => {
    expect(LEYES.LINFONAVIT.urlRef).toMatch(/ref\/lifnvt\.htm$/);
    expect(LEYES.LINFONAVIT.vigenciaFallback).toBe("2025-02-21");
  });
  it("claves de más larga a más corta y alternancia escapada", () => {
    for (let i = 1; i < CLAVES_LEYES.length; i++) expect(CLAVES_LEYES[i - 1].length).toBeGreaterThanOrEqual(CLAVES_LEYES[i].length);
    const alt = alternanciaClaves();
    expect(alt.indexOf("RLISR")).toBeLessThan(alt.indexOf("|LISR|"));
    expect(alt).toContain("LRART76\\-VI");
    expect(alt.split("|").at(-1)).toBe("RMF");
  });
  it("clavesPorMateria: lo que el contador puede pedir completo", () => {
    const pld = clavesPorMateria(["pld"]);
    expect(pld).toEqual(expect.arrayContaining(["LFPIORPI", "RLFPIORPI"]));
    expect(clavesPorMateria(["fiscal"])).toEqual(expect.arrayContaining(["LISR", "LIVA", "CFF", "RLISR", "LHPUE", "CFCDMX"]));
    expect(clavesPorMateria(["fiscal"])).not.toContain("CPEUM");
  });
});
