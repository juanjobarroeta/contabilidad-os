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
  gastosFacturados12m: 0,
  nomina12m: 0,
  bancos: null,
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

  /** Facturado mensual empatado a los periodos declarados, escalado por un factor. */
  function facturadoComo(declaraciones: InsumosCredito["declaraciones"], factor: number) {
    return declaraciones.map((d) => ({ periodo: d.periodo, total: Math.round((d.ingresos ?? 0) * factor) }));
  }

  it("con CFDIs consistentes el score sube y deja de excluir dimensiones", () => {
    const r = calcularScoreCredito({
      ...BASE,
      opinionSat: "POSITIVA",
      cfdis: {
        ingresosFacturados: 3_500_000,
        facturadoPorMes: facturadoComo(BASE.declaraciones, 1.0),
        emitidosVigentes: 190,
        emitidosCancelados: 4,
        topClientePct: 22,
        clientesActivos: 25,
      },
    });
    expect(r.dimensiones.map((d) => d.clave)).toEqual([
      "actividad", "cumplimiento", "consistencia", "capacidad", "clientes", "efos",
    ]);
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.banda).toBe("A");
  });

  it("capacidad de pago: gastos altos comen el margen y bajan el límite", () => {
    const cfdis = {
      ingresosFacturados: 3_000_000,
      facturadoPorMes: facturadoComo(BASE.declaraciones, 1.0),
      emitidosVigentes: 100, emitidosCancelados: 2, topClientePct: 30, clientesActivos: 10,
    };
    const margenAlto = calcularScoreCredito({ ...BASE, cfdis, gastosFacturados12m: 0 });
    // Gastos ≈ 90% del ingreso: casi sin flujo libre.
    const margenBajo = calcularScoreCredito({ ...BASE, cfdis, gastosFacturados12m: 2_900_000 });
    const capAlto = margenAlto.dimensiones.find((d) => d.clave === "capacidad")!;
    const capBajo = margenBajo.dimensiones.find((d) => d.clave === "capacidad")!;
    expect(capBajo.puntos).toBeLessThan(capAlto.puntos);
    expect(margenBajo.limiteSugerido).toBeLessThan(margenAlto.limiteSugerido);
  });

  it("flujo bancario negativo sostenido baja capacidad; positivo la sube", () => {
    const cfdis = {
      ingresosFacturados: 3_000_000,
      facturadoPorMes: facturadoComo(BASE.declaraciones, 1.0),
      emitidosVigentes: 100, emitidosCancelados: 2, topClientePct: 30, clientesActivos: 10,
    };
    const positivo = calcularScoreCredito({
      ...BASE, cfdis,
      bancos: { mesesConDatos: 6, abonosProm: 260_000, cargosProm: 200_000 },
    });
    const negativo = calcularScoreCredito({
      ...BASE, cfdis,
      bancos: { mesesConDatos: 6, abonosProm: 200_000, cargosProm: 280_000 },
    });
    const capPos = positivo.dimensiones.find((d) => d.clave === "capacidad")!;
    const capNeg = negativo.dimensiones.find((d) => d.clave === "capacidad")!;
    expect(capNeg.puntos).toBeLessThan(capPos.puntos);
    // Con bancos presentes, la cobertura ya no reclama estados de cuenta.
    expect(positivo.cobertura.join(" ")).not.toMatch(/Estados de cuenta/);
  });

  it("declarar MÁS de lo facturado NO castiga (venta a público en general)", () => {
    const base = { ingresosFacturados: 0, emitidosVigentes: 100, emitidosCancelados: 2, topClientePct: 30, clientesActivos: 10 };
    const igual = calcularScoreCredito({ ...BASE, cfdis: { ...base, facturadoPorMes: facturadoComo(BASE.declaraciones, 1.0) } });
    const declaraMas = calcularScoreCredito({ ...BASE, cfdis: { ...base, facturadoPorMes: facturadoComo(BASE.declaraciones, 0.58) } });
    const consIgual = igual.dimensiones.find((d) => d.clave === "consistencia")!;
    const consDeclaraMas = declaraMas.dimensiones.find((d) => d.clave === "consistencia")!;
    expect(consDeclaraMas.puntos).toBe(consIgual.puntos);
  });

  it("facturar MÁS de lo declarado sí castiga (posible subdeclaración)", () => {
    const base = { ingresosFacturados: 0, emitidosVigentes: 100, emitidosCancelados: 2, topClientePct: 30, clientesActivos: 10 };
    const sano = calcularScoreCredito({ ...BASE, cfdis: { ...base, facturadoPorMes: facturadoComo(BASE.declaraciones, 1.0) } });
    const subdeclara = calcularScoreCredito({ ...BASE, cfdis: { ...base, facturadoPorMes: facturadoComo(BASE.declaraciones, 1.6) } });
    expect(subdeclara.score).toBeLessThan(sano.score);
  });

  it("meses de CFDIs SIN declaración no entran a la comparación (backfill a medias)", () => {
    const base = { ingresosFacturados: 0, emitidosVigentes: 100, emitidosCancelados: 2, topClientePct: 30, clientesActivos: 10 };
    // Facturado sólo en meses fuera de los declarados → sin solape → neutral.
    const r = calcularScoreCredito({
      ...BASE,
      cfdis: { ...base, facturadoPorMes: [{ periodo: "2030-01", total: 999_999 }] },
    });
    const cons = r.dimensiones.find((d) => d.clave === "consistencia")!;
    expect(cons.razones.join(" ")).toMatch(/comparación aplazada/);
  });

  it("tasa de cancelación alta castiga (perfil refacturador)", () => {
    const base = { ingresosFacturados: 0, facturadoPorMes: facturadoComo(BASE.declaraciones, 1.0), topClientePct: 30, clientesActivos: 10 };
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
