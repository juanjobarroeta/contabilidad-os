import { describe, expect, it } from "vitest";
import { etiquetaDeNaturaleza } from "./naturaleza-caja";
import { IGNORED_TAGS_VALIDOS } from "../contabilidad/posting";

describe("etiquetaDeNaturaleza", () => {
  // LA PRUEBA QUE IMPORTA. El primer intento guardaba el texto del Excel
  // («Excel de conciliación de caja: TRASPASO») en `notes`, que es el campo de
  // ETIQUETA. Los 19 movimientos quedaban marcados y agosto no podía cerrar:
  // `postMonth` los contaba como «ignorados sin categoría». Nada en el tipo lo
  // impide —notes es string—, así que lo tiene que sostener una prueba.
  it("sólo devuelve etiquetas que el cierre acepta", () => {
    const naturalezas = [
      "TRASPASO",
      "TRASPASO ENTRE CUENTAS",
      "nomina",
      "BANCARIZACION",
      "DEV DE FAC MEDICAMENTO",
      "PÚBLICO EN GENERAL",
      "",
      null,
      undefined,
    ];
    for (const n of naturalezas) {
      const tag = etiquetaDeNaturaleza(n);
      if (tag !== null) expect(IGNORED_TAGS_VALIDOS.has(tag), `«${n}» → ${tag}`).toBe(true);
    }
  });

  it("reconoce el traspaso entre cuentas propias", () => {
    expect(etiquetaDeNaturaleza("TRASPASO")).toBe("INTERNAL_TRANSFER");
    expect(etiquetaDeNaturaleza("TRASPASO ENTRE CUENTAS")).toBe("INTERNAL_TRANSFER");
    expect(etiquetaDeNaturaleza("nomina")).toBe("INTERNAL_TRANSFER");
  });

  // Una devolución NO es un traspaso: se netea contra su pago original. Darle
  // INTERNAL_TRANSFER la sacaría del libro sin dejar el vínculo.
  it("no inventa etiqueta para lo que necesita a una persona", () => {
    expect(etiquetaDeNaturaleza("DEV DE FAC MEDICAMENTO")).toBeNull();
    expect(etiquetaDeNaturaleza("BANCARIZACION")).toBeNull();
    expect(etiquetaDeNaturaleza("")).toBeNull();
    expect(etiquetaDeNaturaleza(null)).toBeNull();
  });
});
