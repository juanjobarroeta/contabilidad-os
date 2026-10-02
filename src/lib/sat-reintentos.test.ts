import { describe, expect, it } from "vitest";
import { decidirNuevaSolicitud, solicitudViva, MAX_FALLOS_POR_RANGO, REINTENTO_TRAS_FALLO_HORAS } from "./sat-reintentos";

const h = (horasAtras: number, ahora: Date) => new Date(ahora.getTime() - horasAtras * 3_600_000);
const ahora = new Date("2026-10-02T18:00:00Z");
const fallo = (horasAtras: number, msg = "Error no controlado.") => ({ status: "FAILED", errorMessage: msg, createdAt: h(horasAtras, ahora) });

describe("decidirNuevaSolicitud", () => {
  it("sin historia: pide", () => {
    expect(decidirNuevaSolicitud([], ahora)).toEqual({ pedir: true });
  });

  it("5002 en el rango: nunca más, ni con force", () => {
    const r = decidirNuevaSolicitud([fallo(30, "emitidos: … (código 5002)")], ahora, { force: true });
    expect(r.pedir).toBe(false);
    expect(r).toMatchObject({ motivo: "cuota_agotada" });
  });

  it("el caso CENTRO 2026-10-01: dos fallos del SAT → no hay tercer intento", () => {
    const r = decidirNuevaSolicitud([fallo(18), fallo(17)], ahora);
    expect(r).toMatchObject({ pedir: false, motivo: "intentos_agotados" });
    expect(MAX_FALLOS_POR_RANGO).toBe(2);
  });

  it(`un fallo reciente espera ${REINTENTO_TRAS_FALLO_HORAS} h; después pide`, () => {
    expect(decidirNuevaSolicitud([fallo(1)], ahora)).toMatchObject({ pedir: false, motivo: "en_espera" });
    expect(decidirNuevaSolicitud([fallo(REINTENTO_TRAS_FALLO_HORAS + 1)], ahora)).toEqual({ pedir: true });
  });

  it("force salta la espera pero no el tope de intentos", () => {
    expect(decidirNuevaSolicitud([fallo(1)], ahora, { force: true })).toEqual({ pedir: true });
    expect(decidirNuevaSolicitud([fallo(1), fallo(2)], ahora, { force: true }).pedir).toBe(false);
  });

  it("las terminadas y en vuelo no cuentan como fallo", () => {
    const previas = [{ status: "FINISHED", createdAt: h(1, ahora) }, { status: "IN_PROGRESS", createdAt: h(2, ahora) }];
    expect(decidirNuevaSolicitud(previas, ahora)).toEqual({ pedir: true });
  });
});

describe("solicitudViva", () => {
  it("72 h es la vida en el SAT", () => {
    expect(solicitudViva(h(71, ahora), ahora)).toBe(true);
    expect(solicitudViva(h(73, ahora), ahora)).toBe(false);
  });
});
