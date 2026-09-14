import { describe, expect, it } from "vitest";
import { fechaEmisionImss, interpretarOpinionImss, sentidoImss, motivosImss, vigenciaImss } from "./imss";

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

// Formato real del IMSS (visto 13-sep-2026), con datos ficticios.
const REAL_SIN_OPINION = `Opinión del Cumplimiento de Obligaciones Fiscales en materia de Seguridad Social
FECHA: 13 de septiembre de 2026
EMPRESA EJEMPLO SA DE CV
Clave de R.F.C.:
Folio: 17890000000000000000001
EJE010101AAA
Respuesta de opinión:
En atención a su consulta sobre el cumplimiento de obligaciones fiscales en materia de seguridad social, se le informa lo siguiente:
En los controles electrónicos del Instituto Mexicano del Seguro Social, se detectó que su(s) Registro(s) Patronal(es) se encuentra(n) dado(s) de baja, por
lo que no se puede emitir una opinión de cumplimiento de obligaciones fiscales en materia de seguridad social. Por lo anterior, se emite opinión Sin
Opinión.
Esta carta opinión del cumplimiento de obligaciones fiscales tiene una vigencia hasta el 13 de septiembre de 2026, 23:59:59.
Cadena Original: ||Invocante:portalimssdigital|Tramite:Carta de No Adeudo Art. 32D|Fecha:13 de septiembre 2026, 23:58:54|Folio:17890000000000000000001|RFC:EJE010101AAA|Nombre o
Razon Social:EMPRESA EJEMPLO SA DE CV|CURP:|Opinion:SIN OPINIÓN|FechaInicioVigencia:13 de septiembre 2026, 23:58:54|FechaFinVigencia:13 de septiembre de 2026,
23:59:59||
Sello digital: abc==`;

const REAL_POSITIVA = REAL_SIN_OPINION
  .replace("|Opinion:SIN OPINIÓN|", "|Opinion:POSITIVA|")
  .replace("se emite opinión Sin\nOpinión.", "se emite opinión Positiva.")
  .replace("FechaFinVigencia:13 de septiembre de 2026,\n23:59:59", "FechaFinVigencia:13 de octubre de 2026, 23:59:59")
  .replace("vigencia hasta el 13 de septiembre de 2026", "vigencia hasta el 13 de octubre de 2026");

describe("opinión IMSS (OCOFSS) — formato real", () => {
  it("lee la cadena original: sin opinión por registro patronal en baja, con la vigencia que imprime el IMSS", () => {
    const r = interpretarOpinionImss(REAL_SIN_OPINION, undefined, new Date("2026-09-14T00:00:00Z"));
    expect(r.resultado).toBe("SIN_OBLIGACIONES");
    expect(r.vigencia).toBe("2026-09-13");
    expect(r.motivos[0]).toBe("Folio IMSS: 17890000000000000000001");
    expect(r.motivos[1]).toMatch(/Registro\(s\) Patronal\(es\) se encuentra\(n\) dado\(s\) de baja/);
    expect(r.motivos).toHaveLength(2);
  });
  it("positiva: sentido de la cadena, vigencia del IMSS, sin explicación como motivo", () => {
    const r = interpretarOpinionImss(REAL_POSITIVA);
    expect(r.resultado).toBe("POSITIVA");
    expect(r.vigencia).toBe("2026-10-13");
    expect(r.motivos).toEqual(["Folio IMSS: 17890000000000000000001"]);
  });
  it("sin cadena original cae al cuerpo «se emite opinión …» y a «vigencia hasta el …»", () => {
    const sinCadena = REAL_SIN_OPINION.split("Cadena Original")[0];
    expect(sentidoImss(sinCadena)).toBe("SIN_OBLIGACIONES");
    expect(vigenciaImss(sinCadena)).toBe("2026-09-13");
    expect(fechaEmisionImss(sinCadena)).toBe("2026-09-13");
  });
});

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
