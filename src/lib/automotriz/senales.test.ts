import { describe, it, expect } from "vitest";
import { senales, type LineaEvaluable } from "./senales";

// ─────────────────────────────────────────────────────────────────────────────
// Cada caso de aquí es un número que el tablero llegó a mostrar de verdad.
// ─────────────────────────────────────────────────────────────────────────────

const linea = (o: Partial<LineaEvaluable> = {}): LineaEvaluable => ({
  clave: "mano_obra", nombre: "Mano de obra (taller)",
  ingreso: 1_000_000, costo: 400_000, margen: 60, documentos: 300, ...o,
});

describe("senales() — el caso real de Margom", () => {
  it("marca la mano de obra que reportó 98.6% de margen y $30,838 por orden", () => {
    const s = senales([
      linea({ ingreso: 317_190_852, costo: 4_550_342, margen: 98.6, documentos: 10_286 }),
    ]);
    const tipos = s.map((x) => x.tipo);
    expect(tipos).toContain("margen");
    expect(tipos).toContain("ticket");
    // Las dos son graves: no es un caso limítrofe.
    expect(s.every((x) => x.severidad === "alta")).toBe(true);
    // Y se dice qué se esperaba, para poder discutir la banda y no el veredicto.
    expect(s.find((x) => x.tipo === "margen")!.esperado).toBe("40% a 85%");
    expect(s.find((x) => x.tipo === "ticket")!.mensaje).toContain("10,286");
  });

  it("marca las refacciones con 1.8% de costo", () => {
    const s = senales([
      linea({ clave: "refacciones_taller", nombre: "Refacciones en órdenes de taller",
              ingreso: 30_502_041, costo: 542_761, margen: 98.2, documentos: 0 }),
    ]);
    expect(s[0].tipo).toBe("margen");
    expect(s[0].observado).toBe(98.2);
  });

  it("un taller sano no dispara nada", () => {
    expect(senales([linea()])).toHaveLength(0);
  });
});

describe("senales() — muestra sesgada", () => {
  it("avisa cuando el margen se calculó sobre la minoría costeable", () => {
    // El guardia de unidades sacó del costeo a los lubricantes (los de costo
    // alto) y el margen que sobrevivió describe sólo a los que pasaron el
    // filtro. El número dejó de mentir hacia abajo y empezó a mentir hacia
    // arriba: sin esta señal, el 30% se lee como un dato sano.
    const s = senales([
      linea({ clave: "refacciones_taller", nombre: "Refacciones en órdenes de taller",
              ingreso: 1_000_000, costo: 700_000, margen: 30, documentos: 0,
              ingresoSinCosto: 9_000_000 }),
    ]);
    const sesgo = s.find((x) => x.tipo === "muestra_sesgada")!;
    expect(sesgo).toBeDefined();
    expect(sesgo.observado).toBe(90);
    expect(sesgo.severidad).toBe("alta");
  });

  it("no se queja cuando la mayoría del ingreso sí se pudo costear", () => {
    const s = senales([
      linea({ clave: "refacciones_taller", nombre: "Refacciones", ingreso: 9_000_000,
              costo: 6_300_000, margen: 30, documentos: 0, ingresoSinCosto: 1_000_000 }),
    ]);
    expect(s.filter((x) => x.tipo === "muestra_sesgada")).toHaveLength(0);
  });
});

describe("senales() — cuándo NO hablar", () => {
  it("ignora líneas chicas: no vale la pena molestar por $50 mil", () => {
    expect(senales([linea({ ingreso: 50_000, costo: 0, margen: 100, documentos: 1 })])).toHaveLength(0);
  });

  it("ignora líneas sin banda definida en vez de inventarle una", () => {
    expect(
      senales([linea({ clave: "otros_ingresos", nombre: "Bonos", ingreso: 52_000_000, costo: 0, margen: 100 })])
    ).toHaveLength(0);
  });

  it("sin margen calculable no inventa una señal de margen", () => {
    const s = senales([linea({ margen: null, costo: 400_000, documentos: 300 })]);
    expect(s.filter((x) => x.tipo === "margen")).toHaveLength(0);
  });

  it("una línea sin costo se reporta por lo que es, no como margen raro", () => {
    const s = senales([linea({ ingreso: 5_000_000, costo: 0, margen: 100, documentos: 400 })]);
    expect(s.some((x) => x.tipo === "sin_costo")).toBe(true);
    expect(s.find((x) => x.tipo === "sin_costo")!.mensaje).toContain("no es real");
  });
});

describe("senales() — orden", () => {
  it("primero lo grave", () => {
    const s = senales([
      // Margen 38% en mano de obra: fuera de banda pero por poco → media.
      linea({ ingreso: 1_000_000, costo: 620_000, margen: 38, documentos: 300 }),
      linea({ clave: "unidades_nuevas", nombre: "Unidades nuevas", ingreso: 50_000_000,
              costo: 20_000_000, margen: 60, documentos: 100 }),
    ]);
    expect(s[0].severidad).toBe("alta");
  });
});
