// ─── Pruebas doradas: reparto de PTU (corrida especial de un toque) ──────────
// Valores 2026: UMA diaria $117.31 → exención 15 UMA = $1,759.65 (Art. 93
// fracc. XIV LISR). Base legal en ptu.ts:
// - Art. 123 LFT: mitad del monto por días trabajados, mitad por salarios
//   devengados en el ejercicio.
// - Art. 127 fracc. VIII LFT (reforma DOF 23-abr-2021): tope individual de
//   3 meses de salario o promedio de PTU de los últimos 3 años, lo más
//   favorable. El excedente por tope NO se redistribuye.
// - Art. 127 fracc. VII LFT: menos de 60 días trabajados → sin derecho
//   (eventuales; aplicado a todos por simplificación documentada).

import { describe, it, expect } from "vitest";
import { repartirPtu } from "./ptu";

const base = {
  employeeId: "a",
  nombre: "Ana Pérez",
  diasTrabajados: 365,
  salarioDiario: 500,
  salarioDevengado: 182500,
};

describe("repartirPtu — Art. 123 LFT: mitad por días, mitad por salarios", () => {
  it("dos empleados con salarios y días distintos", () => {
    const r = repartirPtu({
      montoTotal: 20000,
      empleados: [
        { ...base }, // 365 días, devengado 182,500
        { employeeId: "b", nombre: "Bruno López", diasTrabajados: 100, salarioDiario: 300, salarioDevengado: 30000 },
      ],
    });
    expect(r.excluidos).toHaveLength(0);
    const [a, b] = r.asignaciones;
    // Mitad por días (10,000 entre 465 días): 365/465 y 100/465.
    expect(a.porDias).toBe(7849.46);
    expect(b.porDias).toBe(2150.54);
    // Mitad por salarios (10,000 entre 212,500 devengados).
    expect(a.porSalario).toBe(8588.24);
    expect(b.porSalario).toBe(1411.76);
    expect(a.montoTotal).toBe(16437.7);
    expect(b.montoTotal).toBe(3562.3);
    // Ningún tope activo (3 meses: 45,000 y 27,000).
    expect(a.topado).toBe(false);
    expect(b.topado).toBe(false);
    expect(r.totalAsignado).toBe(20000);
    expect(r.remanentePorTopes).toBe(0);
    // Exención 15 UMA por empleado (Art. 93 fracc. XIV LISR).
    expect(a.montoExento).toBe(1759.65);
    expect(a.montoGravado).toBe(14678.05);
    expect(b.montoExento).toBe(1759.65);
    expect(b.montoGravado).toBe(1802.65);
  });

  it("tope de 3 meses de salario (Art. 127 fracc. VIII): recorta sin redistribuir", () => {
    const r = repartirPtu({
      montoTotal: 100000,
      empleados: [
        { employeeId: "a", nombre: "Ana", diasTrabajados: 365, salarioDiario: 100, salarioDevengado: 36500 },
        { employeeId: "b", nombre: "Bruno", diasTrabajados: 365, salarioDiario: 1000, salarioDevengado: 365000 },
      ],
    });
    const [a, b] = r.asignaciones;
    // Bruto de A: 25,000 (días) + 4,545.45 (salarios) = 29,545.45 > tope
    // 100 × 90 = 9,000 → se topa.
    expect(a.brutoSinTope).toBe(29545.45);
    expect(a.topeIndividual).toBe(9000);
    expect(a.topado).toBe(true);
    expect(a.montoTotal).toBe(9000);
    expect(a.montoExento).toBe(1759.65);
    expect(a.montoGravado).toBe(7240.35);
    // B no se topa (bruto 70,454.55 < 90,000) y NO absorbe el excedente de A.
    expect(b.brutoSinTope).toBe(70454.55);
    expect(b.topado).toBe(false);
    expect(b.montoTotal).toBe(70454.55);
    expect(r.remanentePorTopes).toBe(20545.45);
    expect(r.totalAsignado).toBe(79454.55);
  });

  it("promedio de PTU de 3 años mayor a 3 meses: rige el más favorable", () => {
    const r = repartirPtu({
      montoTotal: 100000,
      empleados: [
        { employeeId: "a", nombre: "Ana", diasTrabajados: 365, salarioDiario: 100, salarioDevengado: 36500, promedioPtu3Anios: 20000 },
        { employeeId: "b", nombre: "Bruno", diasTrabajados: 365, salarioDiario: 1000, salarioDevengado: 365000 },
      ],
    });
    const a = r.asignaciones[0];
    // max(9,000, 20,000) = 20,000 — el promedio histórico es más favorable.
    expect(a.topeIndividual).toBe(20000);
    expect(a.topado).toBe(true);
    expect(a.montoTotal).toBe(20000);
    expect(r.remanentePorTopes).toBe(9545.45);
  });

  it("menos de 60 días trabajados: excluido (Art. 127 fracc. VII) y el reparto se hace entre los demás", () => {
    const r = repartirPtu({
      montoTotal: 10000,
      empleados: [
        { employeeId: "a", nombre: "Ana", diasTrabajados: 59, salarioDiario: 300, salarioDevengado: 17700 },
        { employeeId: "b", nombre: "Bruno", diasTrabajados: 365, salarioDiario: 200, salarioDevengado: 73000 },
      ],
    });
    expect(r.excluidos).toHaveLength(1);
    expect(r.excluidos[0].employeeId).toBe("a");
    expect(r.excluidos[0].motivo).toContain("Art. 127 fracc. VII");
    expect(r.asignaciones).toHaveLength(1);
    // Bruno recibe todo: mitades completas de días y salarios.
    expect(r.asignaciones[0].porDias).toBe(5000);
    expect(r.asignaciones[0].porSalario).toBe(5000);
    expect(r.asignaciones[0].montoTotal).toBe(10000);
    expect(r.totalAsignado).toBe(10000);
  });

  it("60 días exactos: sí participa (frontera de la fracc. VII)", () => {
    const r = repartirPtu({
      montoTotal: 1000,
      empleados: [{ ...base, diasTrabajados: 60, salarioDevengado: 30000 }],
    });
    expect(r.excluidos).toHaveLength(0);
    expect(r.asignaciones).toHaveLength(1);
  });

  it("exención de 15 UMA: por debajo todo exento, por encima grava el excedente", () => {
    const chico = repartirPtu({ montoTotal: 1000, empleados: [{ ...base }] });
    expect(chico.asignaciones[0].montoTotal).toBe(1000);
    expect(chico.asignaciones[0].montoExento).toBe(1000);
    expect(chico.asignaciones[0].montoGravado).toBe(0);

    const grande = repartirPtu({ montoTotal: 2000, empleados: [{ ...base }] });
    expect(grande.asignaciones[0].montoExento).toBe(1759.65); // 15 × 117.31
    expect(grande.asignaciones[0].montoGravado).toBe(240.35);
  });

  it("acepta la UMA del ejercicio de pago (histórica) para la exención", () => {
    const r = repartirPtu({ montoTotal: 2000, empleados: [{ ...base }], umaDiaria: 113.14 });
    expect(r.asignaciones[0].montoExento).toBe(1697.1); // 15 × 113.14 (2025)
    expect(r.asignaciones[0].montoGravado).toBe(302.9);
  });

  it("caso degenerado: sin salarios devengados, ambas mitades se reparten por días", () => {
    const r = repartirPtu({
      montoTotal: 1000,
      empleados: [
        { employeeId: "a", nombre: "Ana", diasTrabajados: 365, salarioDiario: 300, salarioDevengado: 0 },
        { employeeId: "b", nombre: "Bruno", diasTrabajados: 365, salarioDiario: 300, salarioDevengado: 0 },
      ],
    });
    expect(r.asignaciones[0].montoTotal).toBe(500);
    expect(r.asignaciones[1].montoTotal).toBe(500);
  });

  it("monto cero o sin elegibles: reparto vacío", () => {
    expect(repartirPtu({ montoTotal: 0, empleados: [{ ...base }] }).asignaciones).toHaveLength(0);
    const r = repartirPtu({
      montoTotal: 1000,
      empleados: [{ ...base, diasTrabajados: 10 }],
    });
    expect(r.asignaciones).toHaveLength(0);
    expect(r.excluidos).toHaveLength(1);
    expect(r.totalAsignado).toBe(0);
  });
});
