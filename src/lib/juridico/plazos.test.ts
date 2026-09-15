import { describe, expect, it } from "vitest";
import {
  type Calendario,
  computarPlazo,
  diasHabilesRestantes,
  esHabil,
  explicacion,
  inhabilesDeLey,
  lunesDe,
  restarDiasHabiles,
} from "./plazos";

const cal = (fuero: Calendario["fuero"], inhabilesExtra: string[] = []): Calendario => ({
  fuero,
  inhabilesExtra,
  finDeSemanaInhabil: true,
});

describe("los días que la ley mueve al lunes", () => {
  it("encuentra el n-ésimo lunes del mes", () => {
    // 2026: el 1 de febrero cae en domingo, así que el primer lunes es el 2.
    expect(lunesDe(2026, 2, 1)).toBe("2026-02-02");
    expect(lunesDe(2026, 3, 3)).toBe("2026-03-16");
    expect(lunesDe(2026, 11, 3)).toBe("2026-11-16");
    // Un mes que empieza en lunes: ése mismo es el primero.
    expect(lunesDe(2026, 6, 1)).toBe("2026-06-01");
  });

  it("el 1 de octubre sólo es inhábil el año de la transmisión", () => {
    expect(inhabilesDeLey("laboral", 2024)).toContain("2024-10-01");
    expect(inhabilesDeLey("laboral", 2030)).toContain("2030-10-01");
    expect(inhabilesDeLey("laboral", 2026)).not.toContain("2026-10-01");
  });
});

// Ésta es la prueba que justifica todo el módulo: si el amparo y el laboral
// compartieran lista, estos días se computarían mal y el plazo se vencería.
describe("el amparo y el laboral no comparten calendario", () => {
  const divergen: [string, "amparo" | "laboral"][] = [
    ["2026-02-05", "amparo"], // jueves: Art. 19 LA sí, Art. 74 LFT no (se conmemora el lunes 2)
    ["2026-02-02", "laboral"], // lunes: descanso obligatorio sí, Art. 19 LA no
    ["2026-03-16", "laboral"], // lunes: conmemora el 21 de marzo
    ["2026-11-20", "amparo"], // viernes: Art. 19 LA sí, el laboral lo conmemora el lunes 16
    ["2026-11-16", "laboral"],
    ["2026-05-05", "amparo"], // el 5 de mayo no es descanso obligatorio en la LFT
    ["2026-09-14", "amparo"],
    ["2026-10-12", "amparo"],
  ];

  for (const [fecha, inhabilEn] of divergen) {
    const habilEn = inhabilEn === "amparo" ? "laboral" : "amparo";
    it(`el ${fecha} es inhábil en ${inhabilEn} y hábil en ${habilEn}`, () => {
      expect(esHabil(fecha, cal(inhabilEn)).habil).toBe(false);
      expect(esHabil(fecha, cal(habilEn)).habil).toBe(true);
    });
  }

  it("los que sí comparten se respetan en los dos", () => {
    for (const f of ["2026-01-01", "2026-05-01", "2026-09-16", "2026-12-25"]) {
      expect(esHabil(f, cal("amparo")).habil).toBe(false);
      expect(esHabil(f, cal("laboral")).habil).toBe(false);
    }
  });

  it("dice por qué no cuenta, citando el artículo", () => {
    expect(esHabil("2026-02-05", cal("amparo")).motivo).toContain("Art. 19");
    expect(esHabil("2026-02-02", cal("laboral")).motivo).toContain("Art. 74");
    expect(esHabil("2026-09-19", cal("amparo")).motivo).toBe("sábado");
    expect(esHabil("2026-09-20", cal("amparo")).motivo).toBe("domingo");
  });
});

describe("el cómputo", () => {
  it("empieza al día siguiente de que surte efectos, no el de la notificación", () => {
    // Notificación el martes; en laboral surte el mismo día y corre desde el miércoles.
    const c = computarPlazo({ notificacion: "2026-09-15", dias: 3, calendario: cal("laboral") });
    expect(c.inicio).toBe("2026-09-17");
    expect(c.vence).toBe("2026-09-21"); // 17 jue, 18 vie, sáb y dom fuera, 21 lun
  });

  it("en amparo la notificación surte al día hábil siguiente", () => {
    const c = computarPlazo({ notificacion: "2026-09-15", dias: 3, calendario: cal("amparo") });
    // surte el 16… pero el 16 de septiembre es inhábil, así que surte el 17 y corre desde el 18.
    expect(c.pasos.find((p) => p.clase === "surte")?.fecha).toBe("2026-09-17");
    expect(c.inicio).toBe("2026-09-18");
  });

  it("los quince días del amparo, saltando el 12 de octubre", () => {
    // Art. 17 de la Ley de Amparo: quince días hábiles.
    const c = computarPlazo({ notificacion: "2026-10-01", dias: 15, calendario: cal("amparo") });
    expect(c.pasos.some((p) => p.fecha === "2026-10-12" && p.clase === "salta")).toBe(true);
    expect(c.vence).toBe("2026-10-26");
    expect(c.pasos.filter((p) => p.clase === "cuenta")).toHaveLength(15);
  });

  it("el mismo plazo en laboral no salta el 12 de octubre y vence antes", () => {
    const amparo = computarPlazo({ notificacion: "2026-10-01", dias: 15, surteEfectos: "mismo_dia", calendario: cal("amparo") });
    const laboral = computarPlazo({ notificacion: "2026-10-01", dias: 15, calendario: cal("laboral") });
    expect(laboral.vence < amparo.vence).toBe(true);
  });

  it("cuenta exactamente los días pedidos y numera cada uno", () => {
    const c = computarPlazo({ notificacion: "2026-12-18", dias: 10, calendario: cal("federal") });
    const contados = c.pasos.filter((p) => p.clase === "cuenta");
    expect(contados).toHaveLength(10);
    expect(contados.map((p) => p.dia)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // El último día contado es el vencimiento: no sobra ni falta un día.
    expect(contados[contados.length - 1].fecha).toBe(c.vence);
    // Ningún día contado es inhábil.
    for (const p of contados) expect(esHabil(p.fecha, cal("federal")).habil).toBe(true);
  });

  it("los días naturales cuentan sábados, domingos y festivos", () => {
    const c = computarPlazo({ notificacion: "2026-09-15", dias: 5, tipo: "naturales", calendario: cal("laboral") });
    expect(c.vence).toBe("2026-09-21");
    expect(c.pasos.filter((p) => p.clase === "salta")).toHaveLength(0);
    expect(c.pasos.some((p) => p.fecha === "2026-09-16" && p.clase === "cuenta")).toBe(true);
  });

  it("un plazo natural que vence en inhábil se recorre y lo dice", () => {
    // Ocho días naturales desde el 11 de septiembre de 2026 caen en sábado 19.
    const c = computarPlazo({ notificacion: "2026-09-11", dias: 8, tipo: "naturales", calendario: cal("laboral") });
    expect(c.vence).toBe("2026-09-21");
    expect(c.pasos.some((p) => p.clase === "recorre")).toBe(true);
    expect(c.advertencias.some((a) => a.includes("recorrió"))).toBe(true);
  });

  it("respeta los inhábiles que carga el despacho", () => {
    const vacaciones = ["2026-09-17", "2026-09-18"];
    const sin = computarPlazo({ notificacion: "2026-09-15", dias: 3, calendario: cal("federal") });
    const con = computarPlazo({ notificacion: "2026-09-15", dias: 3, calendario: cal("federal", vacaciones) });
    expect(con.vence > sin.vence).toBe(true);
    expect(con.pasos.find((p) => p.fecha === "2026-09-17")?.motivo).toContain("órgano");
  });

  it("los pasos van en orden y sin repetir fecha", () => {
    const c = computarPlazo({ notificacion: "2026-01-29", dias: 20, calendario: cal("amparo") });
    const fechas = c.pasos.filter((p) => p.clase !== "surte" || p.fecha !== c.pasos[0].fecha).map((p) => p.fecha);
    expect([...fechas]).toEqual([...fechas].sort());
    const cuentanYsaltan = c.pasos.filter((p) => p.clase === "cuenta" || p.clase === "salta").map((p) => p.fecha);
    expect(new Set(cuentanYsaltan).size).toBe(cuentanYsaltan.length);
  });

  it("nunca se presenta sin advertencias", () => {
    const c = computarPlazo({ notificacion: "2026-09-15", dias: 3, calendario: cal("laboral") });
    expect(c.advertencias.length).toBeGreaterThan(0);
    expect(c.advertencias.some((a) => a.includes("surte efectos"))).toBe(true);
    expect(c.advertencias.some((a) => a.includes("suspensiones de labores"))).toBe(true);
  });

  it("cruza el fin de año sin perderse", () => {
    const c = computarPlazo({ notificacion: "2026-12-23", dias: 5, calendario: cal("laboral") });
    // 24 jue cuenta, 25 vie inhábil, 26-27 fin de semana, 28-31 cuentan.
    expect(c.vence).toBe("2026-12-31");
    expect(c.pasos.some((p) => p.fecha === "2026-12-25" && p.clase === "salta")).toBe(true);
  });

  it("cruza a otro año y aplica los inhábiles del año nuevo", () => {
    const c = computarPlazo({ notificacion: "2026-12-29", dias: 5, calendario: cal("laboral") });
    expect(c.pasos.some((p) => p.fecha === "2027-01-01" && p.clase === "salta")).toBe(true);
    expect(c.vence.startsWith("2027-01")).toBe(true);
  });

  it("un día de plazo también funciona", () => {
    const c = computarPlazo({ notificacion: "2026-09-15", dias: 1, calendario: cal("laboral") });
    expect(c.inicio).toBe("2026-09-17");
    expect(c.vence).toBe("2026-09-17");
  });
});

describe("lo que ve el abogado", () => {
  it("cuenta los hábiles que faltan", () => {
    expect(diasHabilesRestantes("2026-09-21", cal("laboral"), "2026-09-15")).toBe(3); // el 16 es inhábil: quedan 17, 18 y 21
    expect(diasHabilesRestantes("2026-09-15", cal("laboral"), "2026-09-15")).toBe(0);
    expect(diasHabilesRestantes("2026-09-10", cal("laboral"), "2026-09-15")).toBe(0);
  });

  it("explica el cómputo en una frase", () => {
    const c = computarPlazo({ notificacion: "2026-10-01", dias: 15, calendario: cal("amparo") });
    const t = explicacion(c);
    expect(t).toContain("15 días hábiles");
    expect(t).toContain(c.vence);
    expect(t).toMatch(/saltando \d+ días inhábiles/);
  });
});

describe("recordar antes de que venza", () => {
  it("cuenta hacia atrás en días hábiles, no de calendario", () => {
    // Del lunes 26 de octubre de 2026, tres hábiles antes es el miércoles 21:
    // el 24 y 25 son fin de semana y no cuentan.
    expect(restarDiasHabiles("2026-10-26", 3, cal("amparo"))).toBe("2026-10-21");
  });

  it("salta los inhábiles del fuero al retroceder", () => {
    // Del martes 13 de octubre, dos hábiles antes salta el 12 (Art. 19 LA) y
    // el fin de semana: cae en el jueves 8.
    expect(restarDiasHabiles("2026-10-13", 2, cal("amparo"))).toBe("2026-10-08");
    // En laboral el 12 sí es hábil, así que se queda más cerca.
    expect(restarDiasHabiles("2026-10-13", 2, cal("laboral"))).toBe("2026-10-09");
  });

  it("cero días devuelve la misma fecha", () => {
    expect(restarDiasHabiles("2026-10-26", 0, cal("amparo"))).toBe("2026-10-26");
  });
});
