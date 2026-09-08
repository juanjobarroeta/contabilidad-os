import { describe, expect, it } from "vitest";
import {
  calcularVencimiento,
  diasHabilesExtraPorRfc,
  esDiaInhabilCff,
  fechaCalendarioIso,
  nextBusinessDay,
  type ObligacionConfig,
} from "./obligaciones";

const mensual: ObligacionConfig = {
  tipo: "IVA_MENSUAL",
  descripcion: "IVA mensual",
  periodicidad: "MENSUAL",
  diaVencimiento: 17,
};

describe("non-business days under CFF Article 12", () => {
  it.each([
    [new Date(2026, 1, 2), "2026-02-03"], // first Monday in February
    [new Date(2026, 2, 16), "2026-03-17"], // third Monday in March
    [new Date(2026, 4, 5), "2026-05-06"],
    [new Date(2026, 8, 16), "2026-09-17"],
    [new Date(2026, 10, 16), "2026-11-17"], // third Monday in November
  ])("moves %s to its next business day", (input, expected) => {
    expect(fechaCalendarioIso(nextBusinessDay(input))).toBe(expected);
  });

  it("does not treat the old fixed commemoration date as the holiday", () => {
    expect(esDiaInhabilCff(new Date(2026, 1, 5))).toBe(false);
  });

  it("moves a Saturday deadline through the weekend", () => {
    expect(fechaCalendarioIso(nextBusinessDay(new Date(2023, 5, 17)))).toBe("2023-06-19");
  });
});

describe("calcularVencimiento", () => {
  it("returns September 17 for the August 2026 monthly period", () => {
    expect(fechaCalendarioIso(calcularVencimiento(mensual, "2026-08"))).toBe("2026-09-17");
  });

  it("supports an explicitly applicable sixth-RFC-digit extension", () => {
    const extraDays = diasHabilesExtraPorRfc("ABC010122AB3");
    expect(extraDays).toBe(1);
    expect(
      fechaCalendarioIso(
        calcularVencimiento(mensual, "2026-08", {
          diasHabilesAdicionales: extraDays ?? 0,
        }),
      ),
    ).toBe("2026-09-18");
  });

  it("does not double-count when the base day falls on a weekend", () => {
    expect(
      fechaCalendarioIso(
        calcularVencimiento(
          mensual,
          "2023-05", // June 17, 2023 was Saturday
          { diasHabilesAdicionales: 1 },
        ),
      ),
    ).toBe("2023-06-19");
  });

  it("rejects malformed RFCs for deadline extensions", () => {
    expect(diasHabilesExtraPorRfc("not-an-rfc")).toBeNull();
  });
});
