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

describe("destinos afinados del copiloto", () => {
  it("REP faltante lleva al centro de complementos, donde se emite", () => {
    expect(ctaParaHallazgo("cfdi.rep_faltante")).toEqual({
      label: "Emitir complemento",
      href: "/facturas?tab=complementos",
    });
  });

  it("69-B lleva al directorio de proveedores (ahí está la situación por RFC)", () => {
    expect(ctaParaHallazgo("efos.presunto")?.href).toBe("/proveedores");
    expect(ctaParaHallazgo("efos.definitivo")?.href).toBe("/proveedores");
    expect(ctaParaHallazgo("efos.alguna_clave_futura")?.href).toBe("/proveedores");
  });
});

describe("posible duplicado con contraparte en el mensaje", () => {
  // La plantilla vive en duplicados.ts:149 — si cambia allá, cambia aquí.
  it("aterriza en Facturas filtrado a la contraparte", () => {
    const cta = ctaParaHallazgo("cfdi.posible_duplicado", {
      mensaje: "2 CFDIs de egreso casi idénticos a PAPELERA CENTRAL SA DE CV por $4,872.00 el 2026-08-04 — posible duplicado.",
    });
    expect(cta?.href).toBe(`/facturas?q=${encodeURIComponent("PAPELERA CENTRAL SA DE CV")}`);
  });

  it("acepta la variante «de» del seed de la demo", () => {
    const cta = ctaParaHallazgo("cfdi.posible_duplicado", {
      mensaje: "2 CFDIs de egreso casi idénticos de PAPELERA CENTRAL por $4,872.00 el mismo día — posible duplicado.",
    });
    expect(cta?.href).toBe(`/facturas?q=${encodeURIComponent("PAPELERA CENTRAL")}`);
  });

  it("sin mensaje reconocible cae a la lista de facturas", () => {
    expect(ctaParaHallazgo("cfdi.posible_duplicado")?.href).toBe("/facturas");
    expect(ctaParaHallazgo("cfdi.posible_duplicado", { mensaje: "otra cosa" })?.href).toBe("/facturas");
  });
});
