import { describe, it, expect } from "vitest";
import {
  compararBalanzas,
  diffEstaLimpio,
  parsePeriodo,
  periodoMesAnterior,
  mensajeHallazgo,
  periodoLargo,
  cuentasQueNoCuadran,
  nudgeCEPresentacion,
  CE_DEEP_LINK,
  type CuentaBalanza,
} from "./ce-reconciliacion";

const cta = (cuenta: string, saldoFinal: number, debe = 0, haber = 0, descripcion?: string): CuentaBalanza => ({
  cuenta,
  saldoFinal,
  debe,
  haber,
  descripcion,
});

describe("compararBalanzas — comparación pura SAT vs libro", () => {
  it("balanza idéntica → sin discrepancias ni faltantes (caso limpio)", () => {
    const sat = [cta("102.01", 58000, 10000, 2000), cta("201.01", 28000, 0, 8000)];
    const libro = [cta("102.01", 58000, 10000, 2000), cta("201.01", 28000, 0, 8000)];
    const diff = compararBalanzas({ periodo: "2026-05", sat, libro });
    expect(diff.discrepancias).toHaveLength(0);
    expect(diff.faltantesEnLibro).toHaveLength(0);
    expect(diff.faltantesEnSat).toHaveLength(0);
    expect(diff.cuentasComparadas).toBe(2);
    expect(diffEstaLimpio(diff)).toBe(true);
  });

  it("detecta diferencia de saldo final que supera la tolerancia", () => {
    const sat = [cta("102.01", 58000)];
    const libro = [cta("102.01", 57000)];
    const diff = compararBalanzas({ periodo: "2026-05", sat, libro });
    expect(diff.discrepancias).toHaveLength(1);
    const d = diff.discrepancias[0];
    expect(d.cuenta).toBe("102.01");
    expect(d.tipo).toBe("SALDO_FINAL");
    expect(d.saldoSat).toBe(58000);
    expect(d.saldoLibro).toBe(57000);
    expect(d.diff).toBe(1000);
    expect(diffEstaLimpio(diff)).toBe(false);
  });

  it("detecta diferencias independientes en debe y haber", () => {
    const sat = [cta("500.01", 0, 5000, 5000)];
    const libro = [cta("500.01", 0, 4000, 3000)];
    const diff = compararBalanzas({ periodo: "2026-05", sat, libro });
    const tipos = diff.discrepancias.map((d) => d.tipo).sort();
    expect(tipos).toEqual(["DEBE", "HABER"]);
    expect(diff.discrepancias.find((d) => d.tipo === "DEBE")?.diff).toBe(1000);
    expect(diff.discrepancias.find((d) => d.tipo === "HABER")?.diff).toBe(2000);
  });

  it("respeta la tolerancia: diferencias <= tolerancia NO se reportan", () => {
    // tolerancia por defecto = 1 peso
    const sat = [cta("102.01", 58000.5)];
    const libro = [cta("102.01", 58000)]; // dif 0.5 < 1 → ignorada
    expect(compararBalanzas({ periodo: "2026-05", sat, libro }).discrepancias).toHaveLength(0);

    // dif exactamente igual a la tolerancia → NO se reporta (regla con `>`)
    const sat2 = [cta("102.01", 59000)];
    const libro2 = [cta("102.01", 58999)]; // dif 1 == tol → ignorada
    expect(compararBalanzas({ periodo: "2026-05", sat: sat2, libro: libro2 }).discrepancias).toHaveLength(0);

    // dif por encima de la tolerancia → sí se reporta
    const sat3 = [cta("102.01", 59001.01)];
    const libro3 = [cta("102.01", 58999)]; // dif > 1
    expect(compararBalanzas({ periodo: "2026-05", sat: sat3, libro: libro3 }).discrepancias).toHaveLength(1);
  });

  it("tolerancia configurable", () => {
    const sat = [cta("102.01", 58500)];
    const libro = [cta("102.01", 58000)]; // dif 500
    expect(compararBalanzas({ periodo: "2026-05", sat, libro, toleranciaPesos: 1000 }).discrepancias).toHaveLength(0);
    expect(compararBalanzas({ periodo: "2026-05", sat, libro, toleranciaPesos: 100 }).discrepancias).toHaveLength(1);
  });

  it("marca cuentas presentes en el SAT y ausentes en el libro", () => {
    const sat = [cta("102.01", 58000), cta("205.01", 3000, 0, 3000, "IVA por pagar")];
    const libro = [cta("102.01", 58000)];
    const diff = compararBalanzas({ periodo: "2026-05", sat, libro });
    expect(diff.faltantesEnLibro).toHaveLength(1);
    expect(diff.faltantesEnLibro[0].cuenta).toBe("205.01");
    expect(diff.faltantesEnLibro[0].saldoFinal).toBe(3000);
    expect(diff.faltantesEnSat).toHaveLength(0);
    expect(diff.discrepancias).toHaveLength(0); // las faltantes no son discrepancia de saldo
    expect(diffEstaLimpio(diff)).toBe(false);
  });

  it("marca cuentas presentes en el libro y ausentes en el SAT", () => {
    const sat = [cta("102.01", 58000)];
    const libro = [cta("102.01", 58000), cta("601.84", 1200, 1200, 0, "Comisiones bancarias")];
    const diff = compararBalanzas({ periodo: "2026-05", sat, libro });
    expect(diff.faltantesEnSat).toHaveLength(1);
    expect(diff.faltantesEnSat[0].cuenta).toBe("601.84");
    expect(diff.faltantesEnLibro).toHaveLength(0);
  });

  it("cuentasComparadas cuenta la unión de claves de ambos lados", () => {
    const sat = [cta("A", 1), cta("B", 2)];
    const libro = [cta("B", 2), cta("C", 3)];
    const diff = compararBalanzas({ periodo: "2026-05", sat, libro });
    expect(diff.cuentasComparadas).toBe(3); // A, B, C
  });

  it("colapsa cuentas duplicadas sumando magnitudes antes de comparar", () => {
    const sat = [cta("102.01", 30000, 5000, 1000), cta("102.01", 28000, 5000, 1000)]; // suma 58000/10000/2000
    const libro = [cta("102.01", 58000, 10000, 2000)];
    expect(compararBalanzas({ periodo: "2026-05", sat, libro }).discrepancias).toHaveLength(0);
  });

  it("ignora claves vacías", () => {
    const sat = [cta("  ", 999), cta("102.01", 58000)];
    const libro = [cta("102.01", 58000)];
    const diff = compararBalanzas({ periodo: "2026-05", sat, libro });
    expect(diff.cuentasComparadas).toBe(1);
    expect(diffEstaLimpio(diff)).toBe(true);
  });

  it("ordena discrepancias de forma estable (cuenta, luego tipo)", () => {
    const sat = [cta("300", 0, 100, 0), cta("100", 50, 0, 0)];
    const libro = [cta("300", 0, 0, 0), cta("100", 0, 0, 0)];
    const diff = compararBalanzas({ periodo: "2026-05", sat, libro });
    expect(diff.discrepancias.map((d) => d.cuenta)).toEqual(["100", "300"]);
  });
});

describe("mensajeHallazgo — texto FORMAL", () => {
  it("resume conteos y detalla discrepancias", () => {
    const sat = [cta("102.01", 58000), cta("205.01", 3000)];
    const libro = [cta("102.01", 57000), cta("601.84", 1200)];
    const diff = compararBalanzas({ periodo: "2026-05", sat, libro });
    const msg = mensajeHallazgo(diff);
    expect(msg).toContain("2026-05");
    expect(msg).toContain("saldos distintos");
    expect(msg).toContain("ausentes en el libro");
    expect(msg).toContain("ausentes en el SAT");
    expect(msg).toContain("102.01");
  });
});

describe("parsePeriodo / periodoMesAnterior", () => {
  it("parsea YYYY-MM", () => {
    expect(parsePeriodo("2026-05")).toEqual({ year: 2026, month: 5 });
    expect(parsePeriodo(" 2025-12 ")).toEqual({ year: 2025, month: 12 });
  });

  it("rechaza formatos inválidos", () => {
    expect(() => parsePeriodo("2026/05")).toThrow();
    expect(() => parsePeriodo("2026-13")).toThrow();
    expect(() => parsePeriodo("abc")).toThrow();
  });

  it("calcula el mes cerrado anterior, cruzando año", () => {
    expect(periodoMesAnterior(new Date(Date.UTC(2026, 5, 15)))).toBe("2026-05"); // junio → mayo
    expect(periodoMesAnterior(new Date(Date.UTC(2026, 0, 10)))).toBe("2025-12"); // enero → dic año previo
  });
});

describe("periodoLargo", () => {
  it("formatea YYYY-MM a 'mes de año'", () => {
    expect(periodoLargo("2026-05")).toBe("mayo de 2026");
    expect(periodoLargo("2025-01")).toBe("enero de 2025");
    expect(periodoLargo("2024-12")).toBe("diciembre de 2024");
  });
  it("devuelve el crudo si el formato o el mes es inválido", () => {
    expect(periodoLargo("2026/05")).toBe("2026/05");
    expect(periodoLargo("2026-13")).toBe("2026-13");
  });
});

describe("cuentasQueNoCuadran — cuentas DISTINTAS divergentes", () => {
  it("cero cuando la conciliación está limpia", () => {
    const diff = compararBalanzas({ periodo: "2026-05", sat: [cta("100", 1)], libro: [cta("100", 1)] });
    expect(cuentasQueNoCuadran(diff)).toBe(0);
  });
  it("una cuenta con varias magnitudes en discrepancia cuenta una sola vez", () => {
    const sat = [cta("500.01", 0, 5000, 5000)];
    const libro = [cta("500.01", 0, 4000, 3000)]; // DEBE y HABER divergen
    const diff = compararBalanzas({ periodo: "2026-05", sat, libro });
    expect(diff.discrepancias.length).toBe(2);
    expect(cuentasQueNoCuadran(diff)).toBe(1);
  });
  it("suma cuentas con discrepancia + faltantes en ambos lados, sin duplicar", () => {
    const sat = [cta("100", 50), cta("205.01", 3000)];
    const libro = [cta("100", 40), cta("601.84", 1200)]; // 100 diverge; 205.01 falta en libro; 601.84 falta en SAT
    const diff = compararBalanzas({ periodo: "2026-05", sat, libro });
    expect(cuentasQueNoCuadran(diff)).toBe(3);
  });
});

describe("nudgeCEPresentacion — composición del push de presentación asistida", () => {
  it("cuadra → 'lista para presentar' con deep link", () => {
    const diff = compararBalanzas({ periodo: "2026-05", sat: [cta("100", 1)], libro: [cta("100", 1)] });
    const n = nudgeCEPresentacion(diff);
    expect(n.title).toBe("Tu Contabilidad Electrónica de mayo de 2026 está lista para presentar");
    expect(n.body).toContain("Cuadra con la balanza del SAT");
    expect(n.url).toBe(CE_DEEP_LINK);
    expect(n.tag).toBe("ce-presentar-2026-05");
  });

  it("no cuadra → 'no cuadra con el SAT en N cuentas — revísala antes de presentar'", () => {
    const sat = [cta("100", 50), cta("205.01", 3000)];
    const libro = [cta("100", 40), cta("601.84", 1200)];
    const diff = compararBalanzas({ periodo: "2026-05", sat, libro });
    const n = nudgeCEPresentacion(diff);
    expect(n.title).toContain("no cuadra con el SAT");
    expect(n.title).toContain("mayo de 2026");
    expect(n.body).toContain("3 cuentas");
    expect(n.body).toContain("revísala antes de presentar");
    expect(n.url).toBe(CE_DEEP_LINK);
  });

  it("singulariza '1 cuenta' cuando sólo diverge una", () => {
    const sat = [cta("100", 50)];
    const libro = [cta("100", 40)];
    const diff = compararBalanzas({ periodo: "2026-03", sat, libro });
    const n = nudgeCEPresentacion(diff);
    expect(n.body).toContain("1 cuenta —");
    expect(n.body).not.toContain("1 cuentas");
    expect(n.tag).toBe("ce-presentar-2026-03");
  });
});
