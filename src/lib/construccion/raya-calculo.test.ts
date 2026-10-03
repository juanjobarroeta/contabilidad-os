import { describe, expect, it } from "vitest";
import {
  calcularDetalle,
  lunesDe,
  isoDia,
  fechaDia,
  precioHora,
  rangoSemana,
  totalesRaya,
} from "./raya-calculo";

const porDia = { tipoPago: "DIA" as const, tarifa: 400, horasJornada: 8 }; // $50/h
const porHora = { tipoPago: "HORA" as const, tarifa: 60, horasJornada: 8 };

describe("precioHora", () => {
  it("por día: jornal entre horas de jornada", () => {
    expect(precioHora(porDia)).toBe(50);
  });
  it("por hora: la tarifa misma", () => {
    expect(precioHora(porHora)).toBe(60);
  });
});

describe("calcularDetalle", () => {
  it("semana completa por día: 6 días × jornal", () => {
    const dias = Array.from({ length: 6 }, () => ({ horas: 8, horasExtra: 0 }));
    expect(calcularDetalle(porDia, dias)).toEqual({
      diasTrabajados: 6,
      horas: 48,
      horasExtra: 0,
      bruto: 2400,
      descuento: 0,
      importe: 2400,
    });
  });

  it("medio día cuenta medio jornal", () => {
    const r = calcularDetalle(porDia, [{ horas: 4, horasExtra: 0 }]);
    expect(r.bruto).toBe(200);
    expect(r.diasTrabajados).toBe(1);
  });

  it("horas extra al doble de la hora normal", () => {
    // 8 h × $60 + 2 h extra × $120 = 480 + 240
    const r = calcularDetalle(porHora, [{ horas: 8, horasExtra: 2 }]);
    expect(r.bruto).toBe(720);
  });

  it("descuenta anticipos del bruto", () => {
    const r = calcularDetalle(porDia, [{ horas: 8, horasExtra: 0 }], 150);
    expect(r).toMatchObject({ bruto: 400, descuento: 150, importe: 250 });
  });

  it("un anticipo mayor que la semana deja el pago en 0, no negativo", () => {
    const r = calcularDetalle(porDia, [{ horas: 8, horasExtra: 0 }], 1000);
    expect(r).toMatchObject({ bruto: 400, descuento: 400, importe: 0 });
  });

  it("días sin horas no cuentan como días trabajados", () => {
    const r = calcularDetalle(porDia, [
      { horas: 8, horasExtra: 0 },
      { horas: 0, horasExtra: 0 },
    ]);
    expect(r.diasTrabajados).toBe(1);
  });
});

describe("totalesRaya", () => {
  it("total = jornales + destajo", () => {
    expect(totalesRaya([2400, 1850.5], 3000)).toEqual({ totalJornales: 4250.5, total: 7250.5 });
  });
  it("raya sólo de destajo (sin jornales)", () => {
    expect(totalesRaya([], 5000)).toEqual({ totalJornales: 0, total: 5000 });
  });
});

describe("semanas", () => {
  it("lunesDe: de cualquier día al lunes de su semana", () => {
    expect(isoDia(lunesDe(fechaDia("2026-10-01")))).toBe("2026-09-28"); // jueves
    expect(isoDia(lunesDe(fechaDia("2026-09-28")))).toBe("2026-09-28"); // lunes
    expect(isoDia(lunesDe(fechaDia("2026-10-04")))).toBe("2026-09-28"); // domingo
  });
  it("rangoSemana es [lunes, lunes siguiente)", () => {
    const { desde, hasta } = rangoSemana(fechaDia("2026-10-01"));
    expect([isoDia(desde), isoDia(hasta)]).toEqual(["2026-09-28", "2026-10-05"]);
  });
  it("fechaDia rechaza formatos que no son YYYY-MM-DD", () => {
    expect(() => fechaDia("01/10/2026")).toThrow();
  });
});
