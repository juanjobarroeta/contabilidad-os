import { describe, expect, it } from "vitest";
import {
  TTL_CORRIDA_MS,
  bloqueaNuevaCorrida,
  corridaDe,
  iniciarCorrida,
  type CorridaBackfill,
} from "./backfill-operador";

const base = (over: Partial<CorridaBackfill> = {}): CorridaBackfill => ({
  companyId: "c1",
  estado: "corriendo",
  inicio: new Date("2026-09-03T17:00:00Z").toISOString(),
  fin: null,
  maxAcuses: 24,
  acusesParseados: 0,
  mesesCreados: 0,
  ultimoPeriodo: null,
  topeAlcanzado: false,
  error: null,
  ...over,
});

describe("backfill-operador: ¿bloquea una corrida nueva?", () => {
  const t0 = new Date("2026-09-03T17:00:00Z");
  it("sin corrida previa no bloquea", () => {
    expect(bloqueaNuevaCorrida(null, t0)).toBe(false);
  });
  it("una corrida en curso reciente bloquea (doble clic)", () => {
    expect(bloqueaNuevaCorrida(base(), new Date(t0.getTime() + 60_000))).toBe(true);
  });
  it("una corrida 'corriendo' más vieja que el TTL se considera colgada y no bloquea", () => {
    expect(bloqueaNuevaCorrida(base(), new Date(t0.getTime() + TTL_CORRIDA_MS + 1))).toBe(false);
  });
  it("terminada o con error no bloquea", () => {
    expect(bloqueaNuevaCorrida(base({ estado: "terminado" }), t0)).toBe(false);
    expect(bloqueaNuevaCorrida(base({ estado: "error" }), t0)).toBe(false);
  });
});

describe("backfill-operador: ciclo de una corrida", () => {
  it("arranca, reporta avance y termina", async () => {
    const id = `t-${Math.random()}`;
    let resolver!: () => void;
    const motor = (async (companyId: string, _c: unknown, opts: { onAvance?: (a: { acusesParseados: number; mesesCreados: number; ultimoPeriodo: string }) => void }) => {
      opts.onAvance?.({ acusesParseados: 1, mesesCreados: 2, ultimoPeriodo: "2026-01" });
      await new Promise<void>((r) => (resolver = r));
      return { companyId, rfc: "X", acusesParseados: 3, mesesCreados: 5, topeAlcanzado: false };
    }) as never;

    const { iniciada, corrida } = iniciarCorrida(id, 24, motor);
    expect(iniciada).toBe(true);
    expect(corrida.estado).toBe("corriendo");
    expect(corridaDe(id)?.acusesParseados).toBe(1);
    expect(corridaDe(id)?.ultimoPeriodo).toBe("2026-01");

    // Segundo clic mientras corre: no arranca otra.
    expect(iniciarCorrida(id, 24, motor).iniciada).toBe(false);

    resolver();
    await new Promise((r) => setTimeout(r, 0));
    expect(corridaDe(id)?.estado).toBe("terminado");
    expect(corridaDe(id)?.mesesCreados).toBe(5);
    expect(corridaDe(id)?.fin).not.toBeNull();
  });

  it("un motor que lanza deja la corrida en error", async () => {
    const id = `t-${Math.random()}`;
    const motor = (async () => { throw new Error("Syntage caído"); }) as never;
    iniciarCorrida(id, 24, motor);
    await new Promise((r) => setTimeout(r, 0));
    expect(corridaDe(id)?.estado).toBe("error");
    expect(corridaDe(id)?.error).toBe("Syntage caído");
  });
});
