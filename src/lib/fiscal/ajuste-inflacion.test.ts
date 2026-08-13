import { describe, expect, it } from "vitest";
import {
  calcularAjusteInflacion,
  clasificacionPorDefecto,
  factorAjusteAnual,
  saldoPromedioAnual,
  type CuentaSaldos,
} from "./ajuste-inflacion";
import { inpc } from "./inpc";

/** Cuenta con el mismo saldo los 12 meses — el caso fácil de verificar a mano. */
const plana = (cuentaSAT: string, subcuenta: string | null, saldo: number): CuentaSaldos => ({
  cuentaSAT,
  subcuenta,
  nombre: cuentaSAT,
  saldosMensuales: Array(12).fill(saldo),
});

describe("saldoPromedioAnual (Art. 44 frac. I)", () => {
  it("divide entre el número de meses del ejercicio, no entre 12 fijo", () => {
    expect(saldoPromedioAnual(Array(12).fill(1200))).toBe(1200);
    // Ejercicio irregular de 5 meses: promedia sobre 5.
    expect(saldoPromedioAnual([100, 200, 300, 400, 500])).toBe(300);
  });

  it("sin meses no revienta", () => {
    expect(saldoPromedioAnual([])).toBe(0);
  });

  it("promedia los saldos de FIN de mes, no el saldo final del año", () => {
    // Un crédito que se cobra en julio pesa medio año, no cero.
    const saldos = [600, 600, 600, 600, 600, 600, 0, 0, 0, 0, 0, 0];
    expect(saldoPromedioAnual(saldos)).toBe(300);
  });
});

describe("factorAjusteAnual (Art. 44 último párrafo)", () => {
  it("ejercicio regular: INPC de diciembre entre INPC de diciembre anterior", () => {
    const f = factorAjusteAnual(2025);
    expect(f.mesFinal).toEqual({ year: 2025, month: 12 });
    expect(f.mesBase).toEqual({ year: 2024, month: 12 });
    const esperado = inpc(2025, 12)! / inpc(2024, 12)! - 1;
    expect(f.factor).toBeCloseTo(esperado, 10);
    // Inflación 2025 del orden de 3-4%: cordura sobre la cifra, no sólo la fórmula.
    expect(f.factor!).toBeGreaterThan(0.02);
    expect(f.factor!).toBeLessThan(0.06);
  });

  it("ejercicio irregular: base es el mes inmediato anterior al primero", () => {
    const f = factorAjusteAnual(2025, 5, 12);
    expect(f.mesBase).toEqual({ year: 2025, month: 4 });
    expect(f.factor).toBeCloseTo(inpc(2025, 12)! / inpc(2025, 4)! - 1, 10);
  });

  it("sin INPC cargado devuelve factor null en vez de inventar 0", () => {
    // 2026 sólo tiene hasta mayo: un ejercicio 2026 completo aún no es calculable.
    expect(factorAjusteAnual(2026).factor).toBeNull();
  });
});

describe("clasificacionPorDefecto (Arts. 45 y 46)", () => {
  it("bancos y clientes son créditos; la caja NO (Art. 45 frac. VI)", () => {
    expect(clasificacionPorDefecto("102", "102.01").clase).toBe("CREDITO");
    expect(clasificacionPorDefecto("105", "105.01").clase).toBe("CREDITO");
    expect(clasificacionPorDefecto("101", "101.01").clase).toBe("EXCLUIDA");
  });

  it("los impuestos acreditables y los saldos a favor quedan fuera", () => {
    for (const cta of ["113", "114", "118", "119"]) {
      expect(clasificacionPorDefecto(cta, null).clase, cta).toBe("EXCLUIDA");
    }
  });

  it("proveedores y acreedores son deudas", () => {
    expect(clasificacionPorDefecto("201", "201.01").clase).toBe("DEUDA");
    expect(clasificacionPorDefecto("205", null).clase).toBe("DEUDA");
  });

  it("el ISR propio NO es deuda aunque su grupo 213 sí lo sea", () => {
    // La trampa: 213 «Impuestos y derechos por pagar» es deuda, pero la
    // subcuenta 213.03 (ISR propio) está excluida por el Art. 46 último
    // párrafo. La regla de subcuenta debe ganarle a la de cuenta.
    expect(clasificacionPorDefecto("213", null).clase).toBe("DEUDA");
    expect(clasificacionPorDefecto("213", "213.01").clase).toBe("DEUDA");
    expect(clasificacionPorDefecto("213", "213.03").clase).toBe("EXCLUIDA");
  });

  it("las aportaciones para futuros aumentos de capital sí son deuda (Art. 46)", () => {
    expect(clasificacionPorDefecto("301", "301.01").clase).toBe("EXCLUIDA");
    expect(clasificacionPorDefecto("301", "301.03").clase).toBe("DEUDA");
  });

  it("lo que la ley no nombra queda EXCLUIDO (criterio conservador)", () => {
    expect(clasificacionPorDefecto("999", null).clase).toBe("EXCLUIDA");
    expect(clasificacionPorDefecto("151", null).clase).toBe("EXCLUIDA"); // terrenos
    expect(clasificacionPorDefecto("601", "601.01").clase).toBe("EXCLUIDA"); // gasto
  });

  it("marca `revisar` donde la ley depende de quién es el deudor", () => {
    expect(clasificacionPorDefecto("107", null).revisar).toBe(true); // deudores diversos
    expect(clasificacionPorDefecto("102", null).revisar).toBe(false); // bancos: no hay duda
  });

  it("toda regla trae fundamento legal (es lo que defiende la cifra)", () => {
    for (const [cta, sub] of [["102", null], ["213", "213.03"], ["201", null], ["101", null]] as const) {
      expect(clasificacionPorDefecto(cta, sub).fundamento.length).toBeGreaterThan(10);
    }
  });
});

describe("calcularAjusteInflacion (Art. 44)", () => {
  const factorFijo = {
    factor: 0.05,
    inpcFinal: 105,
    inpcBase: 100,
    mesFinal: { year: 2025, month: 12 },
    mesBase: { year: 2024, month: 12 },
  };

  it("deudas > créditos → ACUMULABLE (Art. 44 frac. II)", () => {
    const r = calcularAjusteInflacion({
      year: 2025,
      factorAjuste: factorFijo,
      cuentas: [plana("102", "102.01", 100_000), plana("201", "201.01", 300_000)],
    });
    expect(r.promedioCreditos).toBe(100_000);
    expect(r.promedioDeudas).toBe(300_000);
    expect(r.diferencia).toBe(200_000);
    expect(r.acumulable).toBeCloseTo(10_000, 6); // 200,000 × 0.05
    expect(r.deducible).toBe(0);
  });

  it("créditos > deudas → DEDUCIBLE (Art. 44 frac. III)", () => {
    const r = calcularAjusteInflacion({
      year: 2025,
      factorAjuste: factorFijo,
      cuentas: [plana("105", "105.01", 500_000), plana("201", "201.01", 100_000)],
    });
    expect(r.deducible).toBeCloseTo(20_000, 6); // 400,000 × 0.05
    expect(r.acumulable).toBe(0);
  });

  it("empatados no generan ajuste por ningún lado", () => {
    const r = calcularAjusteInflacion({
      year: 2025,
      factorAjuste: factorFijo,
      cuentas: [plana("102", "102.01", 250_000), plana("201", "201.01", 250_000)],
    });
    expect(r.acumulable).toBe(0);
    expect(r.deducible).toBe(0);
  });

  it("las cuentas excluidas NO mueven la cifra", () => {
    // Caja e IVA acreditable son saldos grandes y tentadores; si se colaran al
    // lado de créditos voltearían el resultado.
    const conExcluidas = calcularAjusteInflacion({
      year: 2025,
      factorAjuste: factorFijo,
      cuentas: [
        plana("102", "102.01", 100_000),
        plana("201", "201.01", 300_000),
        plana("101", "101.01", 900_000), // caja
        plana("118", "118.01", 400_000), // IVA acreditable
        plana("213", "213.03", 700_000), // ISR propio
      ],
    });
    expect(conExcluidas.acumulable).toBeCloseTo(10_000, 6);
  });

  it("un override del contador reclasifica y se marca como sobreescrito", () => {
    const cuentas = [plana("107", "107.01", 200_000), plana("201", "201.01", 200_000)];
    const base = calcularAjusteInflacion({ year: 2025, factorAjuste: factorFijo, cuentas });
    expect(base.promedioCreditos).toBe(200_000); // deudores diversos entra por defecto

    // El contador determina que es un préstamo a un socio (Art. 45 frac. III).
    const conOverride = calcularAjusteInflacion({
      year: 2025,
      factorAjuste: factorFijo,
      cuentas,
      overrides: { "107.01": "EXCLUIDA" },
    });
    expect(conOverride.promedioCreditos).toBe(0);
    expect(conOverride.acumulable).toBeCloseTo(10_000, 6);
    expect(conOverride.cuentas.find((c) => c.clave === "107.01")!.sobreescrita).toBe(true);
  });

  it("sin INPC no propone cifra: calculable=false y advertencia", () => {
    const r = calcularAjusteInflacion({
      year: 2026, // sin diciembre cargado
      cuentas: [plana("102", "102.01", 100_000), plana("201", "201.01", 300_000)],
    });
    expect(r.calculable).toBe(false);
    expect(r.acumulable).toBe(0);
    expect(r.deducible).toBe(0);
    expect(r.advertencias.join(" ")).toMatch(/INPC/);
    // Aun así entrega el detalle: el panel muestra de dónde saldría la cifra.
    expect(r.promedioDeudas).toBe(300_000);
  });

  it("advierte cuando faltan meses por postear (el promedio saldría incompleto)", () => {
    const r = calcularAjusteInflacion({
      year: 2025,
      factorAjuste: factorFijo,
      cuentas: [plana("102", "102.01", 100_000)],
      mesesSinPostear: [11, 12],
    });
    expect(r.advertencias.join(" ")).toMatch(/sin postear/i);
  });

  it("advierte de las cuentas incluidas que dependen de hechos fuera del catálogo", () => {
    const r = calcularAjusteInflacion({
      year: 2025,
      factorAjuste: factorFijo,
      cuentas: [plana("107", "107.01", 200_000)],
    });
    expect(r.advertencias.join(" ")).toMatch(/hechos fuera del catálogo/i);
    // Una cuenta con saldo cero no ensucia la lista de pendientes.
    const limpia = calcularAjusteInflacion({
      year: 2025,
      factorAjuste: factorFijo,
      cuentas: [plana("107", "107.01", 0)],
    });
    expect(limpia.advertencias.join(" ")).not.toMatch(/hechos fuera del catálogo/i);
  });

  it("caso realista: el ajuste NO es cero, que es justo lo que hoy se declara", () => {
    // Empresa apalancada típica: se financia con proveedores y créditos
    // bancarios. Hoy la anual sale con ajuste 0 y pierde ingreso acumulable.
    const r = calcularAjusteInflacion({
      year: 2025,
      cuentas: [
        plana("102", "102.01", 350_000), // bancos
        plana("105", "105.01", 1_200_000), // clientes
        plana("101", "101.01", 50_000), // caja (excluida)
        plana("118", "118.01", 180_000), // IVA acreditable (excluido)
        plana("201", "201.01", 2_400_000), // proveedores
        plana("213", "213.01", 90_000), // IVA por pagar
        plana("213", "213.03", 300_000), // ISR propio (excluido)
      ],
    });
    expect(r.promedioCreditos).toBe(1_550_000);
    expect(r.promedioDeudas).toBe(2_490_000);
    expect(r.calculable).toBe(true);
    expect(r.acumulable).toBeGreaterThan(0);
    expect(r.deducible).toBe(0);
    // Con el INPC real de 2025 el factor ronda 3.6%: unos $34 mil de ingreso
    // acumulable que hoy simplemente no se declaran.
    expect(r.acumulable).toBeGreaterThan(20_000);
    expect(r.acumulable).toBeLessThan(60_000);
  });
});
