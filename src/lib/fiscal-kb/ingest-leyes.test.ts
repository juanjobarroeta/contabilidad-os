import { describe, expect, it } from "vitest";
import { LEYES, parseFechaVigencia } from "./ingest-leyes";

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
  it("las fuentes nuevas están y las estatales/facsímiles traen vigencia de respaldo cuando el texto no la declara", () => {
    for (const c of ["RACERF", "RIPAEDI", "CCOM", "LGSM", "LFPIORPI", "RLFPIORPI", "LFDC", "LHPUE", "CFPUE", "CFCDMX"]) expect(LEYES[c]?.clave).toBe(c);
    expect(LEYES.RIPAEDI.vigenciaFallback).toBe("2012-02-10");
    expect(LEYES.CFPUE.url).toMatch(/^https:\/\/ojp\.puebla\.gob\.mx\//);
  });
});
