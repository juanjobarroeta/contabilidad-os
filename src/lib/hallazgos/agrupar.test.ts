import { describe, expect, it } from "vitest";
import { agruparParaRail, type HallazgoRail } from "./agrupar";

let n = 0;
function h(over: Partial<HallazgoRail>): HallazgoRail {
  n++;
  return {
    id: `h${n}`,
    checkClave: "obligacion.vencimiento.proximo",
    categoria: "obligacion",
    severidad: "warn",
    mensaje: `Tu declaración #${n} venció y no la presentas.`,
    sugerencia: "Presenta de inmediato.",
    ...over,
  };
}

describe("agruparParaRail — de 97 enunciados a pocos grupos-verbo", () => {
  it("las 4 cartas de obligaciones vencidas son UN grupo con verbo y contador", () => {
    const r = agruparParaRail([h({}), h({}), h({}), h({})]);
    expect(r.grupos).toHaveLength(1);
    expect(r.grupos[0]).toMatchObject({
      count: 4,
      titulo: "4 declaraciones por presentar",
      verbo: "Ir a la declaración del mes",
    });
    expect(r.grupos[0].href).toContain("/impuestos");
    expect(r.grupos[0].muestra).toContain("declaración #");
  });

  it("un solo hallazgo conserva su mensaje como titular", () => {
    const r = agruparParaRail([
      h({ checkClave: "contabilidad.balance_descuadrado", categoria: "contabilidad", severidad: "error", mensaje: "Tu balance no cuadra por $1,253,753." }),
    ]);
    expect(r.grupos[0].titulo).toBe("Tu balance no cuadra por $1,253,753.");
    expect(r.grupos[0].muestra).toBeNull();
  });

  it("error antes que warn; a igual severidad gana el grupo más grande", () => {
    const r = agruparParaRail([
      h({}), h({}), // 2 warn obligacion
      h({ checkClave: "cfdi.posible_duplicado", categoria: "cfdi" }),
      h({ checkClave: "contabilidad.balance_descuadrado", categoria: "contabilidad", severidad: "error" }),
    ]);
    expect(r.grupos[0].severidad).toBe("error");
    expect(r.grupos[1].count).toBe(2);
  });

  it("los info se colapsan: no compiten con lo urgente", () => {
    const r = agruparParaRail([
      h({}),
      h({ checkClave: "isn.estimado", categoria: "isn", severidad: "info", mensaje: "ISN estimado $14,880." }),
      h({ checkClave: "isn.tasa", categoria: "isn", severidad: "info", mensaje: "Tasa subió 2.5%." }),
    ]);
    expect(r.grupos).toHaveLength(1);
    expect(r.informativos).toBe(2);
  });

  it("máximo de grupos respetado; los que no caben cuentan en restantes", () => {
    const r = agruparParaRail(
      [
        h({}), h({}),
        h({ checkClave: "cfdi.posible_duplicado", categoria: "cfdi" }),
        h({ checkClave: "banco.ingreso_no_facturado", categoria: "banco" }),
        h({ checkClave: "cumplimiento.csf.estatus", categoria: "cumplimiento" }),
        h({ checkClave: "resico.ingresos_limite", categoria: "resico" }),
      ],
      { maxGrupos: 3 },
    );
    // resico comparte destino con las obligaciones (/impuestos) → se FUNDEN:
    // mismo lugar de arreglo, misma carta. 4 grupos, caben 3.
    expect(r.grupos).toHaveLength(3);
    expect(r.grupos[0].count).toBe(3);
    expect(r.restantes).toBe(1);
  });

  it("checkClave desconocida cae al grupo genérico /hallazgos, jamás se pierde", () => {
    const r = agruparParaRail([h({ checkClave: "x", categoria: "x" })]);
    expect(r.grupos[0].href).toBe("/hallazgos");
  });
});
