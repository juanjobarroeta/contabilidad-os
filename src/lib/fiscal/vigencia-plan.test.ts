import { describe, expect, it } from "vitest";
import {
  cupoPorEmpresa,
  empresasDelTurno,
  horasParaSiguienteTurno,
  inicioVentanaCancelable,
  MIN_POR_EMPRESA,
} from "./vigencia-plan";

describe("reparto del cupo entre empresas", () => {
  it("parte el cupo en rebanadas de al menos MIN_POR_EMPRESA", () => {
    expect(empresasDelTurno(400)).toBe(Math.floor(400 / MIN_POR_EMPRESA));
    expect(cupoPorEmpresa(400, empresasDelTurno(400))).toBeGreaterThanOrEqual(MIN_POR_EMPRESA);
  });

  it("con cupo chico atiende al menos a una empresa (nunca cero)", () => {
    expect(empresasDelTurno(5)).toBe(1);
    expect(cupoPorEmpresa(5, 1)).toBe(5);
  });

  it("el cupo por empresa nunca es cero aunque haya más empresas que cupo", () => {
    expect(cupoPorEmpresa(10, 50)).toBe(1);
  });

  it("reparte parejo", () => {
    expect(cupoPorEmpresa(400, 16)).toBe(25);
  });
});

describe("inicioVentanaCancelable", () => {
  it("de mayo en adelante arranca en enero del ejercicio en curso", () => {
    // Agosto 2026 → ventana de 8 meses → primer día de enero 2026.
    const inicio = inicioVentanaCancelable(new Date("2026-08-12T12:00:00Z"));
    expect(inicio.toISOString().slice(0, 10)).toBe("2026-01-01");
  });

  it("hasta abril alcanza el ejercicio anterior (la anual aún no vence)", () => {
    // Marzo 2026 → 15 meses → enero 2025: lo del año pasado sigue cancelable.
    const inicio = inicioVentanaCancelable(new Date("2026-03-15T12:00:00Z"));
    expect(inicio.toISOString().slice(0, 10)).toBe("2025-01-01");
  });
});

describe("horasParaSiguienteTurno (métrica de escala)", () => {
  it("con pocas empresas todas caben en una corrida: turno inmediato", () => {
    const h = horasParaSiguienteTurno({
      empresasTotales: 16, empresasPorCorrida: 16, corridasPorDia: 16,
    });
    expect(h).toBe(1.5); // una vuelta por corrida, 16 corridas al día
  });

  it("crece con el NÚMERO DE EMPRESAS, no con el de facturas", () => {
    const chico = horasParaSiguienteTurno({
      empresasTotales: 100, empresasPorCorrida: 16, corridasPorDia: 16,
    })!;
    const grande = horasParaSiguienteTurno({
      empresasTotales: 1000, empresasPorCorrida: 16, corridasPorDia: 16,
    })!;
    expect(grande).toBeGreaterThan(chico);
    // 1000 empresas / 16 por corrida = 63 corridas ≈ 4 días. Es la señal de
    // que a esa escala hay que subir cupo/carriles/cadencia.
    expect(Math.round(grande)).toBe(95);
  });

  it("sin corridas o sin empresas por corrida no hay métrica", () => {
    expect(horasParaSiguienteTurno({ empresasTotales: 10, empresasPorCorrida: 0, corridasPorDia: 16 })).toBeNull();
    expect(horasParaSiguienteTurno({ empresasTotales: 10, empresasPorCorrida: 4, corridasPorDia: 0 })).toBeNull();
  });
});
