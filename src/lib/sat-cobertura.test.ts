import { describe, it, expect } from "vitest";
import { esCoberturaSospechosa, coberturaSospechosa, periodoCerrado, UMBRAL_COBERTURA, satDijoSinSolapes, mesCompleto, mesesCompletos } from "./sat-cobertura";

// Los ocho meses de MARGOM pasaron el control anterior —«las dos solicitudes
// llegaron a FINISHED»— con 63, 49, 80, 47 y 3 facturas. Estos casos fijan qué
// cuenta como cubierto y, sobre todo, qué NO se debe declarar roto.

describe("esCoberturaSospechosa", () => {
  it("el SAT dijo 800 y tenemos 3: sospechoso", () => {
    expect(esCoberturaSospechosa({ year: 2025, month: 4, satDijo: 800, tenemos: 3 })).toBe(true);
  });

  it("un mes sin CFDIs NO es sospechoso", () => {
    // 5004 «sin CFDIs en este período» puede ser la verdad: empresa nueva, mes
    // muerto. Declararlo roto mandaría a repescar meses que no existen.
    expect(esCoberturaSospechosa({ year: 2022, month: 1, satDijo: 0, tenemos: 0 })).toBe(false);
  });

  it("tener MÁS de lo que el SAT reportó no es sospechoso", () => {
    // Pasa de verdad: los conteos no son comparables al uno — la solicitud de
    // recibidos filtra `active` y las canceladas entran y salen.
    expect(esCoberturaSospechosa({ year: 2025, month: 1, satDijo: 500, tenemos: 640 })).toBe(false);
  });

  it("no se pelea por diferencias chicas", () => {
    // 90% de cobertura es un mes sano con canceladas de por medio, no un hueco.
    expect(esCoberturaSospechosa({ year: 2025, month: 2, satDijo: 1000, tenemos: 900 })).toBe(false);
  });

  it("el umbral es el límite exacto", () => {
    const justo = { year: 2025, month: 3, satDijo: 1000, tenemos: 1000 * UMBRAL_COBERTURA };
    expect(esCoberturaSospechosa(justo)).toBe(false);
    expect(esCoberturaSospechosa({ ...justo, tenemos: justo.tenemos - 1 })).toBe(true);
  });

  it("respeta un umbral más estricto cuando se lo piden", () => {
    const p = { year: 2025, month: 5, satDijo: 100, tenemos: 70 };
    expect(esCoberturaSospechosa(p)).toBe(false);
    expect(esCoberturaSospechosa(p, 0.9)).toBe(true);
  });
});

describe("coberturaSospechosa", () => {
  it("reporta sólo los huecos, ordenados por tamaño", () => {
    const r = coberturaSospechosa([
      { year: 2025, month: 4, satDijo: 800, tenemos: 0 },   // faltan 800
      { year: 2024, month: 1, satDijo: 900, tenemos: 36 },  // faltan 864
      { year: 2025, month: 6, satDijo: 700, tenemos: 690 }, // sano
      { year: 2022, month: 6, satDijo: 0, tenemos: 0 },     // mes vacío de verdad
    ]);
    expect(r.map((x) => x.periodo)).toEqual(["2024-01", "2025-04"]);
    expect(r[0].faltanCuandoMenos).toBe(864);
    expect(r[1].cobertura).toBe(0);
  });

  it("pone el periodo con dos dígitos de mes", () => {
    const [s] = coberturaSospechosa([{ year: 2023, month: 8, satDijo: 500, tenemos: 0 }]);
    expect(s.periodo).toBe("2023-08");
  });

  it("una ingesta sana no reporta nada", () => {
    expect(
      coberturaSospechosa([
        { year: 2026, month: 1, satDijo: 1200, tenemos: 1200 },
        { year: 2026, month: 2, satDijo: 0, tenemos: 0 },
      ]),
    ).toEqual([]);
  });
});

describe("periodoCerrado", () => {
  const hoy = new Date(Date.UTC(2026, 7, 14)); // 2026-08-14

  it("el mes en curso NO está cerrado", () => {
    expect(periodoCerrado({ year: 2026, month: 8 }, hoy)).toBe(false);
  });

  it("el mes pasado sí", () => {
    expect(periodoCerrado({ year: 2026, month: 7 }, hoy)).toBe(true);
  });

  it("un mes futuro tampoco", () => {
    expect(periodoCerrado({ year: 2026, month: 9 }, hoy)).toBe(false);
  });

  it("cualquier mes de un año anterior sí", () => {
    expect(periodoCerrado({ year: 2025, month: 12 }, hoy)).toBe(true);
  });
});

describe("coberturaSospechosa y el mes en curso", () => {
  const hoy = new Date(Date.UTC(2026, 7, 14));

  it("no acusa al mes en curso por ir a medias", () => {
    // Medido en MARGOM el 2026-08-14: satDijo 6,894 / tenemos 2,087. No le
    // falta nada — le faltan 17 días. Repescarlo gastaría cuota vitalicia en un
    // rango que de todos modos hay que volver a pedir cuando cierre.
    const r = coberturaSospechosa(
      [
        { year: 2026, month: 8, satDijo: 6894, tenemos: 2087 },
        { year: 2025, month: 4, satDijo: 4453, tenemos: 1725 },
        { year: 2024, month: 1, satDijo: 2690, tenemos: 57 },
      ],
      UMBRAL_COBERTURA,
      hoy,
    );
    expect(r.map((x) => x.periodo)).toEqual(["2025-04", "2024-01"]);
    expect(r.reduce((s, x) => s + x.faltanCuandoMenos, 0)).toBe(5361);
  });
});

describe("satDijoSinSolapes (la unión de los rangos, no la suma)", () => {
  const fila = (desde: string, hasta: string, cfdisFound: number, tipo = "EMITIDOS") => ({
    year: 2026, month: 9, tipo, status: "FINISHED", desde, hasta, cfdisFound, createdAt: hasta,
  });

  it("«del 1 a ayer» pedido cada día cuenta el mes una vez (el caso de septiembre ~10x)", () => {
    // 1→2, 1→3, … 1→30: cada día el SAT reporta lo acumulado.
    const filas = Array.from({ length: 29 }, (_, i) => fila("2026-09-01T00:00:00Z", `2026-09-${String(i + 2).padStart(2, "0")}T23:59:59Z`, (i + 2) * 30));
    expect(satDijoSinSolapes(filas).get("2026-9")).toBe(900);
  });

  it("los tramos disjuntos suman; emitidos y recibidos también", () => {
    const m = satDijoSinSolapes([
      fila("2026-09-01T00:00:00Z", "2026-09-15T23:59:59Z", 200),
      fila("2026-09-16T00:00:00Z", "2026-09-30T23:59:59Z", 310),
      fila("2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z", 40, "RECIBIDOS"),
    ]);
    expect(m.get("2026-9")).toBe(550);
  });

  it("ignora lo que no terminó y los tipos que no son descarga", () => {
    const m = satDijoSinSolapes([
      { ...fila("2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z", 99), status: "IN_PROGRESS" },
      fila("2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z", 7, "METADATA"),
    ]);
    expect(m.get("2026-9")).toBeUndefined();
  });
});

describe("mesCompleto (unión de rangos terminados)", () => {
  const f = (tipo: string, d: Date | null, h: Date | null, status = "FINISHED") => ({ tipo, status, desde: d, hasta: h });
  const dia = (d: number, fin = false) => (fin ? new Date(2026, 8, d, 23, 59, 59) : new Date(2026, 8, d, 0, 0, 0));

  it("mes completo por ambos lados → completo; filas sin rango valen como mes completo", () => {
    expect(mesCompleto([f("EMITIDOS", dia(1), dia(30, true)), f("RECIBIDOS", null, null)], 2026, 9)).toBe(true);
  });

  it("«del 1 a ayer» de un mes cerrado NO lo completa", () => {
    expect(mesCompleto([f("EMITIDOS", dia(1), dia(29, true)), f("RECIBIDOS", dia(1), dia(30, true))], 2026, 9)).toBe(false);
  });

  it("dos tramos contiguos sí lo completan; con hueco no", () => {
    const tramos = [f("EMITIDOS", dia(1), dia(15, true)), f("EMITIDOS", dia(16), dia(30, true)), f("RECIBIDOS", null, null)];
    expect(mesCompleto(tramos, 2026, 9)).toBe(true);
    const conHueco = [f("EMITIDOS", dia(1), dia(14, true)), f("EMITIDOS", dia(16), dia(30, true)), f("RECIBIDOS", null, null)];
    expect(mesCompleto(conHueco, 2026, 9)).toBe(false);
  });

  it("sólo un lado, o filas FAILED, no cuentan", () => {
    expect(mesCompleto([f("EMITIDOS", null, null)], 2026, 9)).toBe(false);
    expect(mesCompleto([f("EMITIDOS", null, null), f("RECIBIDOS", null, null, "FAILED")], 2026, 9)).toBe(false);
  });

  it("mesesCompletos agrupa por mes", () => {
    const s = mesesCompletos([
      { year: 2026, month: 8, ...f("EMITIDOS", null, null) }, { year: 2026, month: 8, ...f("RECIBIDOS", null, null) },
      { year: 2026, month: 9, ...f("EMITIDOS", null, null) },
    ]);
    expect([...s]).toEqual(["2026-8"]);
  });
});
