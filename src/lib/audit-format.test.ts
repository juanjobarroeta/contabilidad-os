import { describe, it, expect } from "vitest";
import { etiquetaAccion, resumenDetalle } from "./audit-format";

describe("etiquetaAccion", () => {
  it("traduce las acciones conocidas", () => {
    expect(etiquetaAccion("factura.timbrar")).toBe("CFDI timbrado");
    expect(etiquetaAccion("credenciales.actualizar")).toBe("Credenciales actualizadas");
    expect(etiquetaAccion("conciliacion.unmatch")).toBe("Conciliación deshecha");
  });

  it("devuelve la acción cruda si no está mapeada", () => {
    expect(etiquetaAccion("accion.desconocida")).toBe("accion.desconocida");
  });
});

describe("resumenDetalle", () => {
  it("arma un resumen clave: valor separado por punto medio", () => {
    expect(resumenDetalle({ uuid: "ABC-123", motivo: "02" })).toBe(
      "uuid: ABC-123 · motivo: 02"
    );
  });

  it("formatea números con separador es-MX y booleanos como sí/no", () => {
    expect(resumenDetalle({ total: 1234.5, lote: true })).toBe(
      "total: 1,234.5 · lote: sí"
    );
  });

  it("omite null/undefined/cadenas vacías", () => {
    expect(resumenDetalle({ a: null, b: undefined, c: "", d: "x" })).toBe("d: x");
  });

  it("devuelve cadena vacía para valores no-objeto", () => {
    expect(resumenDetalle(null)).toBe("");
    expect(resumenDetalle("texto")).toBe("");
    expect(resumenDetalle([1, 2])).toBe("");
  });

  it("trunca resúmenes largos con elipsis", () => {
    const largo = resumenDetalle({ campo: "x".repeat(300) }, 50);
    expect(largo.length).toBe(50);
    expect(largo.endsWith("…")).toBe(true);
  });

  it("serializa objetos anidados como JSON compacto", () => {
    expect(resumenDetalle({ objetivo: { txId: "t1" } })).toBe('objetivo: {"txId":"t1"}');
  });
});
