import { describe, it, expect } from "vitest";
import { acotarRazones, filaDeDecision, MAX_DETALLE, MAX_RAZONES, type RazonDecision } from "./decisiones";

const razon = (i: number): RazonDecision => ({ regla: `regla.${i}`, detalle: `detalle ${i}` });

describe("acotarRazones", () => {
  it("deja pasar una lista corta tal cual", () => {
    const rs = [razon(1), razon(2)];
    expect(acotarRazones(rs)).toEqual(rs);
  });

  it("corta por la cola: las razones llegan ordenadas por relevancia", () => {
    const rs = Array.from({ length: 40 }, (_, i) => razon(i));
    const out = acotarRazones(rs);
    expect(out).toHaveLength(MAX_RAZONES);
    expect(out[0].regla).toBe("regla.0");
    expect(out[MAX_RAZONES - 2].regla).toBe(`regla.${MAX_RAZONES - 2}`);
  });

  it("deja constancia de cuántas razones se omitieron", () => {
    // Sin este renglón el rastro miente por omisión: parecería que sólo hubo 12
    // candidatos cuando hubo 40, y el match dudoso se vería más sólido de lo que
    // fue.
    const out = acotarRazones(Array.from({ length: 40 }, (_, i) => razon(i)));
    const ultima = out[out.length - 1];
    expect(ultima.regla).toBe("omitidas");
    expect(ultima.detalle).toContain("29");
  });

  it("no pierde ninguna razón cuando la lista cabe justo", () => {
    const rs = Array.from({ length: MAX_RAZONES }, (_, i) => razon(i));
    const out = acotarRazones(rs);
    expect(out).toHaveLength(MAX_RAZONES);
    expect(out.some((r) => r.regla === "omitidas")).toBe(false);
  });

  it("recorta un detalle larguísimo en vez de guardarlo entero", () => {
    const out = acotarRazones([{ regla: "r", detalle: "x".repeat(1000) }]);
    expect(out[0].detalle).toHaveLength(MAX_DETALLE);
    expect(out[0].detalle.endsWith("…")).toBe(true);
  });

  it("respeta un máximo distinto cuando se lo pasan", () => {
    const out = acotarRazones(Array.from({ length: 10 }, (_, i) => razon(i)), 3);
    expect(out).toHaveLength(3);
    expect(out[2].regla).toBe("omitidas");
  });
});

describe("filaDeDecision", () => {
  const base = {
    companyId: "c1",
    entidad: "BankTransaction",
    entidadId: "tx1",
    motor: "auto-conciliar",
    accion: "match",
    razones: [razon(1)],
  };

  it("pone los valores por omisión del actor y la versión", () => {
    const fila = filaDeDecision(base);
    expect(fila).toMatchObject({ actor: "motor", motorVersion: "1", actorId: null, refs: [] });
  });

  it("respeta el actor y la versión cuando el motor los declara", () => {
    const fila = filaDeDecision({ ...base, actor: "usuario", actorId: "u1", motorVersion: "3" });
    expect(fila).toMatchObject({ actor: "usuario", actorId: "u1", motorVersion: "3" });
  });

  it("acota las razones al guardar, no sólo al leer", () => {
    const fila = filaDeDecision({ ...base, razones: Array.from({ length: 50 }, (_, i) => razon(i)) });
    expect(fila.razones as unknown as RazonDecision[]).toHaveLength(MAX_RAZONES);
  });

  it("acota las refs para que una corrida con cien candidatos no infle la fila", () => {
    const fila = filaDeDecision({ ...base, refs: Array.from({ length: 200 }, (_, i) => `inv${i}`) });
    expect(fila.refs).toHaveLength(40);
  });
});
