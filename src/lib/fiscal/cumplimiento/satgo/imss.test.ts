import { describe, expect, it } from "vitest";
import { fechaEmisionImss, interpretarOpinionImss, sentidoImss, motivosImss } from "./imss";

const POSITIVA = `INSTITUTO MEXICANO DEL SEGURO SOCIAL
Opinión de Cumplimiento de Obligaciones Fiscales en materia de Seguridad Social
Folio: 0123456789ABC
RFC: BJQ190709T52
Fecha de emisión: 12 de agosto de 2026
Sentido de la opinión: POSITIVA
El patrón no tiene créditos fiscales firmes a su cargo.`;

const NEGATIVA = `IMSS
Folio: ZZ99-1
Fecha de emisión: 03/09/2026
Sentido de la opinión: NEGATIVA
Crédito fiscal 12345 periodo 2025-11 cuotas obrero patronales $12,300.00
Recargos periodo 2025-11 $410.00`;

describe("opinión IMSS (OCOFSS)", () => {
  it("lee el sentido, el folio, la emisión y calcula la vigencia a 30 días", () => {
    const r = interpretarOpinionImss(POSITIVA, "data:application/pdf;base64,AAAA", new Date("2026-09-14T00:00:00Z"));
    expect(r.resultado).toBe("POSITIVA");
    expect(r.vigencia).toBe("2026-09-11");
    expect(r.motivos).toEqual(["Folio IMSS: 0123456789ABC"]);
    expect(r.acuseUrl).toMatch(/^data:application\/pdf/);
  });
  it("en la negativa lista los créditos y recargos como motivos", () => {
    const r = interpretarOpinionImss(NEGATIVA);
    expect(r.resultado).toBe("NEGATIVA");
    expect(r.vigencia).toBe("2026-10-03");
    expect(r.motivos.slice(1)).toEqual([
      "Crédito fiscal 12345 periodo 2025-11 cuotas obrero patronales $12,300.00",
      "Recargos periodo 2025-11 $410.00",
    ]);
  });
  it("sin sentido reconocible devuelve ERROR y lo dice, sin inventar", () => {
    const r = interpretarOpinionImss("PDF ilegible");
    expect(r.resultado).toBe("ERROR");
    expect(r.motivos[0]).toMatch(/No se pudo interpretar/);
  });
  it("acentos y espacios raros no estorban", () => {
    expect(sentidoImss("SENTIDO DE LA OPINIÓN:\n   NEGATIVA")).toBe("NEGATIVA");
    expect(fechaEmisionImss("Emitida el 1 de Marzo de 2026")).toBe("2026-03-01");
    expect(motivosImss("hola\nAdeudo por omisión de cuotas 2026-01\n")).toEqual(["Adeudo por omisión de cuotas 2026-01"]);
  });
});
