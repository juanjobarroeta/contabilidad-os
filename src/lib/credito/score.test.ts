import { describe, expect, it } from "vitest";
import { calcularScoreCredito, type InsumosCredito } from "./score";

// Perfil tipo Mercedes: 15 meses declarados, RESICO, sin CFDIs todavía.
function mesesDeclarados(n: number, base = 250_000): InsumosCredito["declaraciones"] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2025, i, 1));
    const periodo = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    return {
      periodo,
      ingresos: base + i * 5_000,
      impuestosPagados: 6_000,
      // Presentada el 15 del mes siguiente → puntual.
      fechaPresentacion: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 15)).toISOString(),
    };
  });
}

const BASE: InsumosCredito = {
  declaraciones: mesesDeclarados(15),
  acusesFaltantes: 0,
  opinionSat: null,
  efosAbiertos: 0,
  cfdis: null,
};

describe("calcularScoreCredito", () => {
  it("perfil sano sin CFDIs: score alto pero PROVISIONAL con cobertura explicada", () => {
    const r = calcularScoreCredito(BASE);
    expect(r.provisional).toBe(true);
    expect(r.cobertura.join(" ")).toMatch(/CFDIs/);
    expect(r.score).toBeGreaterThanOrEqual(65); // actividad+cumplimiento sanos
    expect(r.limiteSugerido).toBeGreaterThan(0);
    // Sólo dimensiones con insumos: actividad, cumplimiento, efos.
    expect(r.dimensiones.map((d) => d.clave)).toEqual(["actividad", "cumplimiento", "efos"]);
  });

  it("EFOS abierto = banda D y límite 0, sin importar el resto", () => {
    const r = calcularScoreCredito({ ...BASE, efosAbiertos: 2 });
    expect(r.banda).toBe("D");
    expect(r.limiteSugerido).toBe(0);
  });

  it("con CFDIs consistentes el score sube y deja de excluir dimensiones", () => {
    const declarado12m = BASE.declaraciones.slice(0, 12).reduce((s, d) => s + (d.ingresos ?? 0), 0);
    const r = calcularScoreCredito({
      ...BASE,
      opinionSat: "POSITIVA",
      cfdis: {
        ingresosFacturados: Math.round(declarado12m * 12 / 15), // consistente con el promedio
        emitidosVigentes: 190,
        emitidosCancelados: 4,
        topClientePct: 22,
        clientesActivos: 25,
      },
    });
    expect(r.dimensiones.map((d) => d.clave)).toEqual([
      "actividad", "cumplimiento", "consistencia", "clientes", "efos",
    ]);
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.banda).toBe("A");
  });

  it("facturación muy por debajo de lo declarado castiga consistencia", () => {
    const sano = calcularScoreCredito({
      ...BASE,
      cfdis: { ingresosFacturados: 3_500_000, emitidosVigentes: 100, emitidosCancelados: 2, topClientePct: 30, clientesActivos: 10 },
    });
    const inconsistente = calcularScoreCredito({
      ...BASE,
      cfdis: { ingresosFacturados: 500_000, emitidosVigentes: 100, emitidosCancelados: 2, topClientePct: 30, clientesActivos: 10 },
    });
    expect(inconsistente.score).toBeLessThan(sano.score);
  });

  it("tasa de cancelación alta castiga (perfil refacturador)", () => {
    const base = { ingresosFacturados: 3_500_000, topClientePct: 30, clientesActivos: 10 };
    const limpio = calcularScoreCredito({ ...BASE, cfdis: { ...base, emitidosVigentes: 100, emitidosCancelados: 2 } });
    const cancelador = calcularScoreCredito({ ...BASE, cfdis: { ...base, emitidosVigentes: 70, emitidosCancelados: 30 } });
    expect(cancelador.score).toBeLessThan(limpio.score);
  });

  it("caída fuerte de ingresos baja la dimensión de actividad", () => {
    const declinando = BASE.declaraciones.map((d, i) => ({ ...d, ingresos: 500_000 - i * 30_000 }));
    const r = calcularScoreCredito({ ...BASE, declaraciones: declinando });
    const actividad = r.dimensiones.find((d) => d.clave === "actividad")!;
    const sana = calcularScoreCredito(BASE).dimensiones.find((d) => d.clave === "actividad")!;
    expect(actividad.puntos).toBeLessThan(sana.puntos);
  });

  it("pocas declaraciones: actividad se excluye y el score queda provisional", () => {
    const r = calcularScoreCredito({ ...BASE, declaraciones: mesesDeclarados(2) });
    expect(r.dimensiones.find((d) => d.clave === "actividad")).toBeUndefined();
    expect(r.provisional).toBe(true);
  });

  it("declaraciones tardías bajan cumplimiento", () => {
    const tardias = BASE.declaraciones.map((d) => {
      const [y, m] = d.periodo.split("-").map(Number);
      return { ...d, fechaPresentacion: new Date(Date.UTC(y, m + 1, 20)).toISOString() }; // dos meses después
    });
    const r = calcularScoreCredito({ ...BASE, declaraciones: tardias });
    const cumpl = r.dimensiones.find((d) => d.clave === "cumplimiento")!;
    const sano = calcularScoreCredito(BASE).dimensiones.find((d) => d.clave === "cumplimiento")!;
    expect(cumpl.puntos).toBeLessThan(sano.puntos);
  });
});
