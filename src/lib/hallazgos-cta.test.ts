import { describe, it, expect } from "vitest";
import { ctaParaHallazgo } from "./hallazgos-cta";

describe("ctaParaHallazgo", () => {
  it("mapea el banco a subir estado de cuenta", () => {
    expect(ctaParaHallazgo("banco.movimientos_desactualizados")?.href).toBe("/bancos");
    expect(ctaParaHallazgo("banco.ingreso_no_facturado")?.label).toBe("Subir estado de cuenta");
  });

  it("mapea credenciales a Mi Empresa", () => {
    expect(ctaParaHallazgo("csd.por_vencer")?.href).toBe("/empresa");
    expect(ctaParaHallazgo("fiel.por_vencer")?.href).toBe("/empresa");
  });

  it("mapea obligación/declaraciones a su pantalla", () => {
    expect(ctaParaHallazgo("obligacion.vencimiento.proximo")?.href).toBe("/impuestos?tab=del-mes");
    expect(ctaParaHallazgo("declaraciones.faltantes")?.href).toBe("/impuestos?tab=historial");
  });

  it("usa respaldo por prefijo para claves no listadas", () => {
    expect(ctaParaHallazgo("banco.algo_nuevo")?.href).toBe("/bancos");
    expect(ctaParaHallazgo("cfdi.algo")?.href).toBe("/facturas");
  });

  it("devuelve null cuando no hay ruta clara", () => {
    expect(ctaParaHallazgo("desconocido.total")).toBeNull();
  });
});
