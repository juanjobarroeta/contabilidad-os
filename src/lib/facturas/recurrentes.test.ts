import { describe, it, expect } from "vitest";
import {
  siguienteEmision,
  debeGenerar,
  avanzar,
  diasDelMes,
  describirCadencia,
  type Periodicidad,
} from "./recurrentes";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("diasDelMes", () => {
  it("mide meses de 31, 30 y 28 días", () => {
    expect(diasDelMes(2026, 1)).toBe(31);
    expect(diasDelMes(2026, 4)).toBe(30);
    expect(diasDelMes(2026, 2)).toBe(28);
  });

  it("2028 es bisiesto: febrero tiene 29", () => {
    expect(diasDelMes(2028, 2)).toBe(29);
  });
});

describe("siguienteEmision", () => {
  it("SEMANAL suma 7 días exactos y cruza el fin de mes", () => {
    expect(iso(siguienteEmision(utc(2026, 1, 28), "SEMANAL", 28))).toBe("2026-02-04");
  });

  it("MENSUAL conserva el día del ancla", () => {
    expect(iso(siguienteEmision(utc(2026, 3, 15), "MENSUAL", 15))).toBe("2026-04-15");
  });

  // El caso que rompe las implementaciones ingenuas: sumar un mes a "31 de
  // enero" da "31 de febrero", que JS normaliza al 3 de marzo.
  it("una serie del 31 cae al 28 en febrero, NO se desborda a marzo", () => {
    expect(iso(siguienteEmision(utc(2026, 1, 31), "MENSUAL", 31))).toBe("2026-02-28");
  });

  it("y en año bisiesto cae al 29", () => {
    expect(iso(siguienteEmision(utc(2028, 1, 31), "MENSUAL", 31))).toBe("2028-02-29");
  });

  it("tras recortarse en febrero, la serie VUELVE al 31 en marzo", () => {
    // Éste es el punto del ancla: si se recalculara desde el 28 recortado, la
    // serie quedaría facturando el 28 para siempre.
    const feb = siguienteEmision(utc(2026, 1, 31), "MENSUAL", 31);
    expect(iso(siguienteEmision(feb, "MENSUAL", 31))).toBe("2026-03-31");
  });

  it("una serie del 30 cae al 28 en febrero y regresa al 30", () => {
    const feb = siguienteEmision(utc(2026, 1, 30), "MENSUAL", 30);
    expect(iso(feb)).toBe("2026-02-28");
    expect(iso(siguienteEmision(feb, "MENSUAL", 30))).toBe("2026-03-30");
  });

  it("BIMESTRAL, TRIMESTRAL y SEMESTRAL saltan 2, 3 y 6 meses", () => {
    expect(iso(siguienteEmision(utc(2026, 1, 10), "BIMESTRAL", 10))).toBe("2026-03-10");
    expect(iso(siguienteEmision(utc(2026, 1, 10), "TRIMESTRAL", 10))).toBe("2026-04-10");
    expect(iso(siguienteEmision(utc(2026, 1, 10), "SEMESTRAL", 10))).toBe("2026-07-10");
  });

  it("ANUAL cruza el año", () => {
    expect(iso(siguienteEmision(utc(2026, 8, 17), "ANUAL", 17))).toBe("2027-08-17");
  });

  it("MENSUAL en diciembre rueda al año siguiente", () => {
    expect(iso(siguienteEmision(utc(2026, 12, 5), "MENSUAL", 5))).toBe("2027-01-05");
  });

  it("TRIMESTRAL desde noviembre cruza el año", () => {
    expect(iso(siguienteEmision(utc(2026, 11, 20), "TRIMESTRAL", 20))).toBe("2027-02-20");
  });
});

describe("debeGenerar", () => {
  const hoy = utc(2026, 8, 17);

  it("genera cuando ya llegó la fecha", () => {
    expect(debeGenerar({ activa: true, proximaEmision: utc(2026, 8, 17) }, hoy)).toBe(true);
  });

  it("genera cuando viene atrasada", () => {
    expect(debeGenerar({ activa: true, proximaEmision: utc(2026, 7, 31) }, hoy)).toBe(true);
  });

  it("no genera antes de tiempo", () => {
    expect(debeGenerar({ activa: true, proximaEmision: utc(2026, 8, 18) }, hoy)).toBe(false);
  });

  it("una serie en pausa nunca genera, aunque esté vencida", () => {
    expect(debeGenerar({ activa: false, proximaEmision: utc(2026, 1, 1) }, hoy)).toBe(false);
  });

  it("deja de generar después de su fecha de fin", () => {
    expect(
      debeGenerar({ activa: true, proximaEmision: utc(2026, 8, 17), fin: utc(2026, 7, 31) }, hoy)
    ).toBe(false);
  });

  it("sigue generando mientras el fin no se alcanza", () => {
    expect(
      debeGenerar({ activa: true, proximaEmision: utc(2026, 8, 17), fin: utc(2026, 12, 31) }, hoy)
    ).toBe(true);
  });

  it("fin nulo equivale a sin fin", () => {
    expect(
      debeGenerar({ activa: true, proximaEmision: utc(2026, 8, 17), fin: null }, hoy)
    ).toBe(true);
  });
});

describe("avanzar", () => {
  it("una serie muy atrasada avanza UN periodo por corrida, no todos de golpe", () => {
    // Abril, con el cron caído desde enero: la siguiente queda en febrero, no
    // en el presente — el cron diario se pone al corriente de una en una.
    const r = { activa: true, proximaEmision: utc(2026, 1, 15) };
    expect(iso(avanzar(r, "MENSUAL", 15))).toBe("2026-02-15");
  });
});

describe("describirCadencia", () => {
  it("describe la próxima emisión de una serie activa", () => {
    expect(describirCadencia("MENSUAL", utc(2026, 3, 31), true)).toBe(
      "Cada mes · próxima el 31 de marzo"
    );
  });

  it("una serie en pausa no promete una próxima fecha", () => {
    expect(describirCadencia("MENSUAL", utc(2026, 3, 31), false)).toBe("Cada mes · en pausa");
  });
});

describe("estabilidad de la serie a 12 meses", () => {
  it("una renta anclada al 31 factura el último día hábil de cada mes, sin deriva", () => {
    const p: Periodicidad = "MENSUAL";
    let f = utc(2026, 1, 31);
    const dias: string[] = [];
    for (let i = 0; i < 12; i++) {
      f = siguienteEmision(f, p, 31);
      dias.push(iso(f));
    }
    expect(dias).toEqual([
      "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31",
      "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30",
      "2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31",
    ]);
  });
});
