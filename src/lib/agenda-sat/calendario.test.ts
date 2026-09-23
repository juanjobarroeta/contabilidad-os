import { describe, expect, it } from "vitest";
import {
  diaMx,
  enMx,
  periodosCerrados,
  primeraRevision,
  siguienteRevision,
  venceEntregable,
  type EstadoRevision,
} from "./calendario";

const PM = "CBA170606FQ8"; // moral, 12 caracteres
const PF_1 = "BAHJ800101AB1"; // física, sexto dígito 1 → +1 día hábil

const mx = (y: number, m: number, d: number, h: number) => enMx({ y, m, d }, h);
const dia = (t: Date | null) => {
  if (!t) return null;
  const x = diaMx(t);
  return `${x.y}-${String(x.m).padStart(2, "0")}-${String(x.d).padStart(2, "0")} ${x.hora}h`;
};

describe("venceEntregable", () => {
  it("declaración de agosto 2026 de una moral: 17-sep", () => {
    expect(venceEntregable("DECLARACION_MENSUAL", "2026-08", PM)).toEqual({ y: 2026, m: 9, d: 17 });
  });
  it("persona física suma los días hábiles de su sexto dígito", () => {
    expect(venceEntregable("DECLARACION_MENSUAL", "2026-08", PF_1)).toEqual({ y: 2026, m: 9, d: 18 });
  });
  it("balanza de agosto: día 3 del segundo mes; 3-oct-2026 es sábado → lunes 5", () => {
    expect(venceEntregable("BALANZA_CE", "2026-08", PM)).toEqual({ y: 2026, m: 10, d: 5 });
  });
  it("balanza de diciembre cruza el año", () => {
    expect(venceEntregable("BALANZA_CE", "2026-12", PM)).toEqual({ y: 2027, m: 2, d: 3 });
  });
  it("cumplimiento: 3 días hábiles después del vencimiento", () => {
    expect(venceEntregable("CUMPLIMIENTO", "2026-08", PM)).toEqual({ y: 2026, m: 9, d: 22 });
  });
});

describe("primeraRevision", () => {
  it("declaración: 3 hábiles antes, a las 21:00 (el 16-sep es inhábil)", () => {
    expect(dia(primeraRevision("DECLARACION_MENSUAL", { y: 2026, m: 9, d: 17 }))).toBe("2026-09-11 21h");
  });
  it("cumplimiento: a las 10:00 del día", () => {
    expect(dia(primeraRevision("CUMPLIMIENTO", { y: 2026, m: 9, d: 22 }))).toBe("2026-09-22 10h");
  });
});

describe("siguienteRevision — declaración que no aparece", () => {
  const vence = { y: 2026, m: 9, d: 17 };
  const base: EstadoRevision = { entregable: "DECLARACION_MENSUAL", vence, estado: "PENDIENTE", intentos: 0, errores: 0 };

  it("revisión temprana sin acuse → la noche del 17", () => {
    const r = siguienteRevision(base, "no_encontrado", mx(2026, 9, 11, 21));
    expect(dia(r.proximaRevision)).toBe("2026-09-17 22h");
    expect(r.estado).toBe("PENDIENTE");
    expect(r.escalar).toBe(false);
  });
  it("la noche del 17 sin acuse → el 18 en la mañana, todavía sin acusar", () => {
    const r = siguienteRevision(base, "no_encontrado", mx(2026, 9, 17, 22));
    expect(dia(r.proximaRevision)).toBe("2026-09-18 10h");
    expect(r.estado).toBe("PENDIENTE");
  });
  it("el 18 en la mañana → el 18 en la noche", () => {
    const r = siguienteRevision(base, "no_encontrado", mx(2026, 9, 18, 10));
    expect(dia(r.proximaRevision)).toBe("2026-09-18 21h");
    expect(r.escalar).toBe(false);
  });
  it("el 18 en la noche sin acuse: se vuelve TARDE y se levanta la mano UNA vez", () => {
    const r = siguienteRevision(base, "no_encontrado", mx(2026, 9, 18, 21));
    expect(r.estado).toBe("TARDE");
    expect(r.escalar).toBe(true);
    expect(dia(r.proximaRevision)).toBe("2026-09-19 21h");
    const r2 = siguienteRevision({ ...base, estado: "TARDE" }, "no_encontrado", mx(2026, 9, 19, 21));
    expect(r2.escalar).toBe(false);
    expect(dia(r2.proximaRevision)).toBe("2026-09-20 21h");
  });
  it("cada noche hasta 5 hábiles después (24-sep), luego cada 3 días", () => {
    const tarde = { ...base, estado: "TARDE" as const };
    expect(dia(siguienteRevision(tarde, "no_encontrado", mx(2026, 9, 23, 21)).proximaRevision)).toBe("2026-09-24 21h");
    expect(dia(siguienteRevision(tarde, "no_encontrado", mx(2026, 9, 24, 21)).proximaRevision)).toBe("2026-09-27 21h");
  });
  it("después de 30 días, cada semana; a los 90, se deja", () => {
    const tarde = { ...base, estado: "TARDE" as const };
    expect(dia(siguienteRevision(tarde, "no_encontrado", mx(2026, 10, 20, 21)).proximaRevision)).toBe("2026-10-27 21h");
    const r = siguienteRevision(tarde, "no_encontrado", mx(2026, 12, 17, 21));
    expect(r.estado).toBe("ABANDONADO");
    expect(r.proximaRevision).toBeNull();
  });
  it("aparece estando TARDE → ENCONTRADO y se cierra el pendiente", () => {
    const r = siguienteRevision({ ...base, estado: "TARDE" }, "encontrado", mx(2026, 9, 21, 21));
    expect(r).toMatchObject({ estado: "ENCONTRADO", proximaRevision: null, desescalar: true });
  });
  it("aparece a tiempo → ENCONTRADO sin nada que cerrar", () => {
    expect(siguienteRevision(base, "encontrado", mx(2026, 9, 11, 21))).toMatchObject({ estado: "ENCONTRADO", desescalar: false });
  });
  it("sin la obligación → NO_APLICA", () => {
    expect(siguienteRevision(base, "no_aplica", mx(2026, 9, 11, 21)).estado).toBe("NO_APLICA");
  });
});

describe("siguienteRevision — errores", () => {
  const vence = { y: 2026, m: 9, d: 17 };
  const base: EstadoRevision = { entregable: "DECLARACION_MENSUAL", vence, estado: "PENDIENTE", intentos: 3, errores: 0 };

  it("un error se reintenta en 2 horas, sin acusar de tarde", () => {
    const ahora = mx(2026, 9, 19, 21);
    const r = siguienteRevision(base, "error", ahora);
    expect(r.proximaRevision?.getTime()).toBe(ahora.getTime() + 2 * 3600_000);
    expect(r).toMatchObject({ estado: "PENDIENTE", errores: 1, escalar: false });
  });
  it("el tercero seguido vuelve a la cadencia, todavía sin acusar", () => {
    const r = siguienteRevision({ ...base, errores: 2 }, "error", mx(2026, 9, 19, 23));
    expect(r).toMatchObject({ estado: "PENDIENTE", errores: 0, escalar: false });
    expect(dia(r.proximaRevision)).toBe("2026-09-20 21h");
  });
});

describe("siguienteRevision — cumplimiento", () => {
  const base: EstadoRevision = { entregable: "CUMPLIMIENTO", vence: { y: 2026, m: 9, d: 22 }, estado: "PENDIENTE", intentos: 0, errores: 0 };
  it("positiva → ENCONTRADO", () => {
    expect(siguienteRevision(base, "encontrado", mx(2026, 9, 22, 10)).estado).toBe("ENCONTRADO");
  });
  it("negativa → otra vez en una semana; a la quinta se deja", () => {
    const r = siguienteRevision(base, "negativa", mx(2026, 9, 22, 10));
    expect(dia(r.proximaRevision)).toBe("2026-09-29 10h");
    expect(r.escalar).toBe(false);
    expect(siguienteRevision({ ...base, intentos: 4 }, "negativa", mx(2026, 10, 20, 10)).estado).toBe("ENCONTRADO");
  });
});

describe("periodosCerrados", () => {
  it("los tres meses cerrados antes del 23-sep-2026", () => {
    expect(periodosCerrados(mx(2026, 9, 23, 12), 1, 3)).toEqual(["2026-08", "2026-07", "2026-06"]);
  });
  it("cruza el año", () => {
    expect(periodosCerrados(mx(2027, 1, 10, 12), 1, 2)).toEqual(["2026-12", "2026-11"]);
  });
});
