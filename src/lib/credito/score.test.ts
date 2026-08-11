import { describe, expect, it } from "vitest";
import { calcularScoreCredito, desacumularIngresosDeclarados, type InsumosCredito } from "./score";

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
  gastosPorMes: [],
  nomina12m: 0,
  bancos: null,
  flujosPPD: null,
  cfdis: null,
};

describe("desacumularIngresosDeclarados (PM Art. 14 / PF 612 Art. 106)", () => {
  const d = (periodo: string, ingresos: number | null) => ({
    periodo, ingresos, impuestosPagados: 0, fechaPresentacion: null,
  });

  it("acumulado del ejercicio → ingreso del mes; enero del año nuevo reinicia", () => {
    // Caso real: PM con acumulado 402k→469k→…→953k y reinicio a 56k en enero.
    const out = desacumularIngresosDeclarados([
      d("2025-11", 895_952), d("2025-12", 953_906), d("2026-01", 56_190), d("2026-02", 181_290),
    ]);
    const por = new Map(out.map((x) => [x.periodo, x.ingresos]));
    expect(por.get("2025-12")).toBe(953_906 - 895_952); // delta del ejercicio
    expect(por.get("2026-01")).toBe(56_190); // primer mes del año: tal cual
    expect(por.get("2026-02")).toBe(181_290 - 56_190);
  });

  it("delta negativo (complementaria a la baja) queda en null, no negativo", () => {
    const out = desacumularIngresosDeclarados([d("2025-03", 300_000), d("2025-04", 250_000)]);
    expect(out.find((x) => x.periodo === "2025-04")?.ingresos).toBeNull();
  });

  it("meses sin dato no rompen la cadena del acumulado", () => {
    const out = desacumularIngresosDeclarados([d("2025-01", 100_000), d("2025-02", null), d("2025-03", 260_000)]);
    expect(out.find((x) => x.periodo === "2025-03")?.ingresos).toBe(160_000);
  });
});

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

  describe("flujo bancario como cota del flujo libre", () => {
    const cfdis = {
      ingresosFacturados: 3_000_000,
      facturadoPorMes: facturadoComo(BASE.declaraciones, 1.0),
      emitidosVigentes: 100, emitidosCancelados: 2, topClientePct: 30, clientesActivos: 10,
    };

    it("neto bancario MENOR que la estimación fiscal la acota (min de ambas)", () => {
      const sinBanco = calcularScoreCredito({ ...BASE, cfdis });
      const conBanco = calcularScoreCredito({
        ...BASE, cfdis,
        bancos: { mesesConDatos: 6, abonosProm: 280_000, cargosProm: 260_000 },
      });
      expect(sinBanco.flujoLibreMensual!).toBeGreaterThan(20_000);
      expect(conBanco.flujoLibreMensual).toBe(20_000); // 280k − 260k
      expect(conBanco.capacidadDesglose?.fuenteFlujo).toBe("bancario");
      expect(conBanco.pagoMensualMax!).toBeLessThan(sinBanco.pagoMensualMax!);
      expect(conBanco.limiteSugerido).toBeLessThan(sinBanco.limiteSugerido);
    });

    it("neto bancario MAYOR que la fiscal no infla el flujo (la fiscal manda)", () => {
      const sinBanco = calcularScoreCredito({ ...BASE, cfdis });
      const conBanco = calcularScoreCredito({
        ...BASE, cfdis,
        bancos: { mesesConDatos: 6, abonosProm: 900_000, cargosProm: 100_000 },
      });
      expect(conBanco.flujoLibreMensual).toBe(sinBanco.flujoLibreMensual);
      expect(conBanco.capacidadDesglose?.fuenteFlujo).toBe("fiscal");
      expect(conBanco.capacidadDesglose?.flujoBancarioNeto).toBe(800_000);
    });

    it("neto bancario NEGATIVO deja el flujo libre (y el pago máximo) en cero", () => {
      const r = calcularScoreCredito({
        ...BASE, cfdis,
        bancos: { mesesConDatos: 6, abonosProm: 200_000, cargosProm: 280_000 },
      });
      expect(r.flujoLibreMensual).toBe(0);
      expect(r.pagoMensualMax).toBe(0);
    });

    it("menos de 3 meses de banco NO acota (sigue siendo solo corroboración ausente)", () => {
      const sinBanco = calcularScoreCredito({ ...BASE, cfdis });
      const pocosMeses = calcularScoreCredito({
        ...BASE, cfdis,
        bancos: { mesesConDatos: 2, abonosProm: 280_000, cargosProm: 260_000 },
      });
      expect(pocosMeses.flujoLibreMensual).toBe(sinBanco.flujoLibreMensual);
      expect(pocosMeses.capacidadDesglose?.fuenteFlujo).toBe("fiscal");
    });

    it("expediente delgado: sin CFDIs pero con ≥3 meses de banco, capacidad se evalúa del banco", () => {
      const r = calcularScoreCredito({
        ...BASE,
        cfdis: null,
        bancos: { mesesConDatos: 6, abonosProm: 100_000, cargosProm: 60_000 },
      });
      const cap = r.dimensiones.find((d) => d.clave === "capacidad");
      expect(cap).toBeDefined();
      expect(r.capacidadDesglose?.fuenteFlujo).toBe("solo_bancario");
      expect(r.flujoLibreMensual).toBe(40_000);
      expect(r.pagoMensualMax).not.toBeNull();
      expect(r.cobertura.join(" ")).toMatch(/únicamente con estados de cuenta/);
    });
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

  it("cartera PPD con mucho saldo insoluto castiga estabilidad de clientes", () => {
    const cfdis = {
      ingresosFacturados: 3_000_000,
      facturadoPorMes: facturadoComo(BASE.declaraciones, 1.0),
      emitidosVigentes: 100, emitidosCancelados: 2, topClientePct: 30, clientesActivos: 10,
    };
    const sana = calcularScoreCredito({
      ...BASE, cfdis,
      flujosPPD: {
        cobranza: { facturas: 20, monto: 1_000_000, cobrado: 900_000, saldoInsoluto: 100_000, diasPromedio: 35 },
        pagos: { facturas: 5, monto: 200_000, pagado: 200_000, diasPromedio: 40 },
      },
    });
    const morosa = calcularScoreCredito({
      ...BASE, cfdis,
      flujosPPD: {
        cobranza: { facturas: 20, monto: 1_000_000, cobrado: 300_000, saldoInsoluto: 700_000, diasPromedio: 120 },
        pagos: { facturas: 5, monto: 200_000, pagado: 200_000, diasPromedio: 40 },
      },
    });
    const cliSana = sana.dimensiones.find((d) => d.clave === "clientes")!;
    const cliMorosa = morosa.dimensiones.find((d) => d.clave === "clientes")!;
    expect(cliMorosa.puntos).toBeLessThan(cliSana.puntos);
  });

  it("pagar a proveedores a más de 120 días castiga capacidad", () => {
    const cfdis = {
      ingresosFacturados: 3_000_000,
      facturadoPorMes: facturadoComo(BASE.declaraciones, 1.0),
      emitidosVigentes: 100, emitidosCancelados: 2, topClientePct: 30, clientesActivos: 10,
    };
    const puntual = calcularScoreCredito({
      ...BASE, cfdis,
      flujosPPD: {
        cobranza: { facturas: 0, monto: 0, cobrado: 0, saldoInsoluto: 0, diasPromedio: null },
        pagos: { facturas: 8, monto: 400_000, pagado: 380_000, diasPromedio: 45 },
      },
    });
    const moroso = calcularScoreCredito({
      ...BASE, cfdis,
      flujosPPD: {
        cobranza: { facturas: 0, monto: 0, cobrado: 0, saldoInsoluto: 0, diasPromedio: null },
        pagos: { facturas: 8, monto: 400_000, pagado: 150_000, diasPromedio: 150 },
      },
    });
    const capPuntual = puntual.dimensiones.find((d) => d.clave === "capacidad")!;
    const capMoroso = moroso.dimensiones.find((d) => d.clave === "capacidad")!;
    expect(capMoroso.puntos).toBeLessThan(capPuntual.puntos);
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
