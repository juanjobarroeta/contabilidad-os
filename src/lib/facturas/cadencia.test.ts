import { describe, it, expect } from "vitest";
import { inferirCadencia, describirCadencia, MIN_OCURRENCIAS } from "./cadencia";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** "Hoy" por defecto: justo después de la última factura de los casos mensuales. */
const HOY = utc(2026, 8, 10);

describe("inferirCadencia — detecta ritmos reales", () => {
  it("una renta el día 1 de cada mes sale MENSUAL anclada al 1", () => {
    const c = inferirCadencia(
      [utc(2026, 5, 1), utc(2026, 6, 1), utc(2026, 7, 1), utc(2026, 8, 1)],
      HOY
    );
    expect(c).not.toBeNull();
    expect(c!.periodicidad).toBe("MENSUAL");
    expect(c!.diaMes).toBe(1);
    expect(c!.ocurrencias).toBe(4);
    expect(iso(c!.proxima)).toBe("2026-09-01");
  });

  it("tolera que se facture el 1, el 2 o el 3 — sigue siendo mensual", () => {
    const c = inferirCadencia(
      [utc(2026, 5, 1), utc(2026, 6, 3), utc(2026, 7, 2), utc(2026, 8, 1)],
      HOY
    );
    expect(c!.periodicidad).toBe("MENSUAL");
  });

  it("una serie de fin de mes se ancla al día MÁS ALTO, no al 28 de febrero", () => {
    // 31/28/31/30 son cuatro días distintos: sin la regla de desempate, la
    // moda podría quedarse en el 28 y anclar la serie al día equivocado.
    const c = inferirCadencia(
      [utc(2026, 1, 31), utc(2026, 2, 28), utc(2026, 3, 31), utc(2026, 4, 30)],
      utc(2026, 5, 5)
    );
    expect(c!.periodicidad).toBe("MENSUAL");
    expect(c!.diaMes).toBe(31);
    // Y la próxima usa la misma regla del cron: mayo tiene 31.
    expect(iso(c!.proxima)).toBe("2026-05-31");
  });

  it("detecta SEMANAL", () => {
    const c = inferirCadencia(
      [utc(2026, 8, 3), utc(2026, 8, 10), utc(2026, 8, 17), utc(2026, 8, 24)],
      utc(2026, 8, 26)
    );
    expect(c!.periodicidad).toBe("SEMANAL");
    expect(iso(c!.proxima)).toBe("2026-08-31");
  });

  it("detecta BIMESTRAL, TRIMESTRAL y ANUAL", () => {
    expect(
      inferirCadencia([utc(2026, 2, 15), utc(2026, 4, 15), utc(2026, 6, 15)], utc(2026, 7, 1))!
        .periodicidad
    ).toBe("BIMESTRAL");
    expect(
      inferirCadencia([utc(2025, 10, 10), utc(2026, 1, 10), utc(2026, 4, 10)], utc(2026, 5, 1))!
        .periodicidad
    ).toBe("TRIMESTRAL");
    expect(
      inferirCadencia([utc(2024, 3, 1), utc(2025, 3, 1), utc(2026, 3, 1)], utc(2026, 5, 1))!
        .periodicidad
    ).toBe("ANUAL");
  });
});

describe("inferirCadencia — se abstiene cuando no hay patrón", () => {
  it("con menos de 3 facturas no hay ritmo, sólo una coincidencia", () => {
    expect(MIN_OCURRENCIAS).toBe(3);
    expect(inferirCadencia([utc(2026, 7, 1), utc(2026, 8, 1)], HOY)).toBeNull();
    expect(inferirCadencia([utc(2026, 8, 1)], HOY)).toBeNull();
    expect(inferirCadencia([], HOY)).toBeNull();
  });

  it("facturas dispersas no son una serie", () => {
    expect(
      inferirCadencia([utc(2026, 1, 5), utc(2026, 3, 20), utc(2026, 8, 2)], HOY)
    ).toBeNull();
  });

  it("una extraordinaria a mitad de mes rompe el patrón aunque la mediana cuadre", () => {
    // Éste es el caso que motiva exigir que TODOS los gaps caigan en la banda:
    // la mediana de estos intervalos parece mensual, pero el ritmo no existe.
    const c = inferirCadencia(
      [
        utc(2026, 4, 1),
        utc(2026, 5, 1),
        utc(2026, 5, 15), // extraordinaria
        utc(2026, 6, 1),
        utc(2026, 7, 1),
      ],
      HOY
    );
    expect(c).toBeNull();
  });

  it("una serie mensual muerta hace ocho meses no se propone", () => {
    const c = inferirCadencia(
      [utc(2025, 10, 1), utc(2025, 11, 1), utc(2025, 12, 1)],
      utc(2026, 8, 10)
    );
    expect(c).toBeNull();
  });

  it("pero un mes de silencio no la mata: sigue viva", () => {
    const c = inferirCadencia(
      [utc(2026, 5, 1), utc(2026, 6, 1), utc(2026, 7, 1)],
      utc(2026, 8, 10)
    );
    expect(c).not.toBeNull();
    expect(c!.periodicidad).toBe("MENSUAL");
  });

  it("dos facturas el mismo día no forman un intervalo", () => {
    expect(
      inferirCadencia([utc(2026, 6, 1), utc(2026, 6, 1), utc(2026, 7, 1)], HOY)
    ).toBeNull();
  });

  it("un intervalo fuera de todas las bandas (quincenal) no se fuerza", () => {
    // 14 días no es semanal ni mensual: preferimos no sugerir a sugerir mal.
    expect(
      inferirCadencia([utc(2026, 7, 1), utc(2026, 7, 15), utc(2026, 7, 29)], utc(2026, 8, 1))
    ).toBeNull();
  });

  it("el orden de entrada no importa: se ordenan antes de medir", () => {
    const c = inferirCadencia(
      [utc(2026, 8, 1), utc(2026, 6, 1), utc(2026, 7, 1)],
      HOY
    );
    expect(c!.periodicidad).toBe("MENSUAL");
    expect(iso(c!.ultima)).toBe("2026-08-01");
  });
});

describe("describirCadencia", () => {
  it("describe una mensual con su día", () => {
    const c = inferirCadencia(
      [utc(2026, 5, 15), utc(2026, 6, 15), utc(2026, 7, 15)],
      utc(2026, 8, 1)
    )!;
    expect(describirCadencia(c)).toBe("cada mes el día 15");
  });

  it("la semanal no menciona día del mes: no significaría nada", () => {
    const c = inferirCadencia(
      [utc(2026, 8, 3), utc(2026, 8, 10), utc(2026, 8, 17)],
      utc(2026, 8, 18)
    )!;
    expect(describirCadencia(c)).toBe("cada semana");
  });
});
