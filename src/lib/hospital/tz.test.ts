import { describe, it, expect } from "vitest";
import { claveDia, diasEntre, diaMesCorto, fechaLocal, finDiaLocal, inicioDiaLocal, partesLocales, rangoMesLocal, sumarDias } from "./tz";

describe("tz (America/Mexico_City, UTC−6 fijo)", () => {
  it("fechaLocal produce el instante de esa hora de pared", () => {
    // 08:20 en CDMX = 14:20Z
    expect(fechaLocal(2026, 9, 2, 8, 20).toISOString()).toBe("2026-09-02T14:20:00.000Z");
    expect(fechaLocal(2026, 9, 3).toISOString()).toBe("2026-09-03T06:00:00.000Z");
  });

  it("partesLocales y claveDia leen el reloj de piso, no el de UTC", () => {
    // 23:50 local del 2 sep = 05:50Z del 3 sep
    const d = new Date("2026-09-03T05:50:00.000Z");
    expect(partesLocales(d)).toMatchObject({ y: 2026, m: 9, d: 2, h: 23, min: 50 });
    expect(claveDia(d)).toBe("2026-09-02");
    expect(claveDia(new Date("2026-09-03T06:00:00.000Z"))).toBe("2026-09-03");
  });

  it("inicioDiaLocal / finDiaLocal acotan el día local", () => {
    const d = new Date("2026-09-03T05:50:00.000Z"); // 2 sep 23:50 local
    expect(inicioDiaLocal(d).toISOString()).toBe("2026-09-02T06:00:00.000Z");
    expect(finDiaLocal(d).toISOString()).toBe("2026-09-03T06:00:00.000Z");
  });

  it("sumarDias y diasEntre cuentan días calendario locales", () => {
    const ingreso = fechaLocal(2026, 9, 2, 8, 20);
    expect(sumarDias(ingreso, 1).toISOString()).toBe("2026-09-03T14:20:00.000Z");
    expect(diasEntre(ingreso, fechaLocal(2026, 9, 3, 0, 10))).toBe(1);
    expect(diasEntre(ingreso, fechaLocal(2026, 9, 2, 23, 59))).toBe(0);
    expect(diasEntre(fechaLocal(2026, 9, 3), ingreso)).toBe(-1);
    // cruce de mes/año
    expect(diasEntre(fechaLocal(2026, 12, 31, 22), fechaLocal(2027, 1, 1, 1))).toBe(1);
  });

  it("rangoMesLocal devuelve [1 del mes, 1 del siguiente) en hora local", () => {
    const r = rangoMesLocal(2026, 12);
    expect(r.desde.toISOString()).toBe("2026-12-01T06:00:00.000Z");
    expect(r.hasta.toISOString()).toBe("2027-01-01T06:00:00.000Z");
  });

  it("diaMesCorto escribe «2 sep»", () => {
    expect(diaMesCorto(fechaLocal(2026, 9, 2, 23, 59))).toBe("2 sep");
    expect(diaMesCorto(fechaLocal(2026, 1, 15))).toBe("15 ene");
  });
});
