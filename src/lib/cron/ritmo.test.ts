import { describe, expect, it } from "vitest";
import {
  ESPERA_DRENADO_MS,
  ESPERA_ERROR_MS,
  ESPERA_TIBIA_MS,
  hayTrabajoPendiente,
  hizoTrabajo,
  siguienteEspera,
} from "./ritmo";

const MIN = 60_000;
const opts = { baseMs: 6 * 60 * MIN, minMs: 5_000 }; // trabajo local, cada 6 h
const satOpts = { baseMs: 4 * 60 * MIN, minMs: 10 * MIN }; // trabajo que toca al SAT

describe("hayTrabajoPendiente", () => {
  it("lee `completado` como la señal más explícita", () => {
    expect(hayTrabajoPendiente({ completado: false })).toBe(true);
    expect(hayTrabajoPendiente({ completado: true })).toBe(false);
  });

  it("lee los contadores de pendientes de los distintos crons", () => {
    expect(hayTrabajoPendiente({ restantes: 212_682 })).toBe(true);
    expect(hayTrabajoPendiente({ pendientes: 0 })).toBe(false);
    expect(hayTrabajoPendiente({ empresasCargando: 2 })).toBe(true);
  });

  it("sin señal devuelve null (no todos los crons llevan la cuenta)", () => {
    expect(hayTrabajoPendiente({ ok: true })).toBeNull();
    expect(hayTrabajoPendiente(null)).toBeNull();
  });
});

describe("hizoTrabajo", () => {
  it("detecta contadores y listas no vacías", () => {
    expect(hizoTrabajo({ actualizadas: 5000 })).toBe(true);
    expect(hizoTrabajo({ cancelados: ["A", "B"] })).toBe(true);
    expect(hizoTrabajo({ actualizadas: 0, checked: 0 })).toBe(false);
    expect(hizoTrabajo({ ok: true })).toBe(false);
  });
});

describe("siguienteEspera", () => {
  it("con pendientes drena RÁPIDO en vez de esperar la cadencia", () => {
    // El caso real: 212k facturas que tardaban 26 días a 2k/6h.
    const espera = siguienteEspera({ status: 200, cuerpo: { restantes: 212_682 } }, opts);
    expect(espera).toBe(ESPERA_DRENADO_MS);
    expect(espera).toBeLessThan(opts.baseMs);
  });

  it("ocioso regresa a la cadencia base (no gasta)", () => {
    expect(siguienteEspera({ status: 200, cuerpo: { restantes: 0 } }, opts)).toBe(opts.baseMs);
    expect(siguienteEspera({ status: 200, cuerpo: { ok: true } }, opts)).toBe(opts.baseMs);
  });

  it("hubo trabajo sin señal de pendientes → espera tibia", () => {
    expect(siguienteEspera({ status: 200, cuerpo: { imported: 12 } }, opts)).toBe(ESPERA_TIBIA_MS);
  });

  it("el PISO del trabajo manda: un cron del SAT nunca se acelera de más", () => {
    // Aunque reporte pendientes, respeta su piso de 10 min: las cuotas del SAT
    // y sus límites no se atropellan por acelerar el drenado.
    const espera = siguienteEspera({ status: 200, cuerpo: { pendientes: 500 } }, satOpts);
    expect(espera).toBe(satOpts.minMs);
    expect(espera).toBeGreaterThan(ESPERA_DRENADO_MS);
  });

  it("un error no se atropella: espera al menos la base", () => {
    expect(siguienteEspera({ status: 500 }, opts)).toBeGreaterThanOrEqual(opts.baseMs);
    expect(siguienteEspera({ status: 0 }, { baseMs: MIN, minMs: 1_000 })).toBe(ESPERA_ERROR_MS);
  });

  it("409 (otra corrida tiene el candado) reintenta pronto, sin perder el turno", () => {
    const espera = siguienteEspera({ status: 409 }, opts);
    expect(espera).toBeLessThan(opts.baseMs);
    expect(espera).toBeGreaterThanOrEqual(opts.minMs);
  });

  it("nunca devuelve una espera por debajo del piso", () => {
    const duro = { baseMs: 30 * MIN, minMs: 20 * MIN };
    for (const señal of [
      { status: 200, cuerpo: { restantes: 10 } },
      { status: 409 },
      { status: 200, cuerpo: { imported: 3 } },
    ]) {
      expect(siguienteEspera(señal, duro)).toBeGreaterThanOrEqual(duro.minMs);
    }
  });
});
