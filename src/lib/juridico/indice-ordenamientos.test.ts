import { describe, expect, it } from "vitest";
import { citasEnProsa } from "@/lib/ai/citas-prosa";
import { indiceOrdenamientos } from "./indice-ordenamientos";

// El índice se llenaba en local y quedaba VACÍO en producción: los catálogos
// se cargaban con un require() dinámico que webpack no resuelve, y el catch lo
// escondía. Esta prueba falla si vuelve a pasar.
describe("índice de ordenamientos", () => {
  it("carga los catálogos de verdad, no una lista vacía", () => {
    const i = indiceOrdenamientos();
    expect(i.length).toBeGreaterThan(1500);
    expect(i.some((e) => e.clave === "LISR")).toBe(true);
    expect(i.some((e) => e.clave === "CHH-C-PROCEDIMIENTOS-FAMILIARES-CH")).toBe(true);
  });

  it("resuelve la cita en prosa que falló en producción", () => {
    const t = "El artículo 2273 del Código Civil para el Estado Libre y Soberano de Puebla establece que el arrendador está obligado a entregar el bien.";
    const c = citasEnProsa(t, indiceOrdenamientos());
    expect(c.map((x) => x.cita)).toEqual(["ART. 2273 PUE-C-CIVIL-PUEBLA"]);
  });
});
