import { describe, it, expect } from "vitest";
import { computeEstadoDatos, type EstadoDatosRequest } from "./estado-datos";

const req = (
  status: string,
  year: number,
  month: number
): EstadoDatosRequest => ({ status, year, month });

describe("computeEstadoDatos", () => {
  it("sin FIEL y sin facturas: todo apagado, sin períodos", () => {
    const estado = computeEstadoDatos({ invoiceCount: 0, fielOk: false, requests: [] });
    expect(estado).toEqual({
      tieneFacturas: false,
      fielConfigurada: false,
      sincronizando: false,
      sinResultados: false,
    });
    expect(estado.periodosTotales).toBeUndefined();
    expect(estado.periodosPendientes).toBeUndefined();
  });

  it("FIEL + solicitudes pendientes: sincronizando con conteo de períodos", () => {
    const estado = computeEstadoDatos({
      invoiceCount: 0,
      fielOk: true,
      requests: [
        // 2026-05 completo (ambos tipos FINISHED), 2026-06 aún en curso
        req("FINISHED", 2026, 5),
        req("FINISHED", 2026, 5),
        req("PENDING", 2026, 6),
        req("IN_PROGRESS", 2026, 6),
        req("ACCEPTED", 2026, 4),
      ],
      ultimaSincronizacion: new Date("2026-07-03T10:00:00Z"),
    });
    expect(estado.sincronizando).toBe(true);
    expect(estado.sinResultados).toBe(false);
    expect(estado.periodosTotales).toBe(3);
    expect(estado.periodosPendientes).toBe(2);
    expect(estado.ultimaSincronizacion).toBe("2026-07-03T10:00:00.000Z");
  });

  it("FIEL + todo terminado + 0 facturas: sinResultados (no girar para siempre)", () => {
    const estado = computeEstadoDatos({
      invoiceCount: 0,
      fielOk: true,
      requests: [
        req("FINISHED", 2026, 5),
        req("FINISHED", 2026, 6),
        req("FAILED", 2026, 4), // terminal: no cuenta como pendiente
        req("EXPIRED", 2026, 3), // terminal: no cuenta como pendiente
      ],
    });
    expect(estado.sincronizando).toBe(false);
    expect(estado.sinResultados).toBe(true);
    expect(estado.periodosTotales).toBe(4);
    expect(estado.periodosPendientes).toBe(0);
  });

  it("FIEL sin solicitudes aún: ni sincronizando ni sinResultados", () => {
    const estado = computeEstadoDatos({ invoiceCount: 0, fielOk: true, requests: [] });
    expect(estado.fielConfigurada).toBe(true);
    expect(estado.sincronizando).toBe(false);
    expect(estado.sinResultados).toBe(false);
  });

  it("con facturas presentes: todas las banderas apagadas aunque haya pendientes", () => {
    const estado = computeEstadoDatos({
      invoiceCount: 42,
      fielOk: true,
      requests: [req("PENDING", 2026, 6), req("FINISHED", 2026, 5)],
    });
    expect(estado.tieneFacturas).toBe(true);
    expect(estado.sincronizando).toBe(false);
    expect(estado.sinResultados).toBe(false);
    // Los conteos siguen disponibles como dato informativo.
    expect(estado.periodosTotales).toBe(2);
    expect(estado.periodosPendientes).toBe(1);
  });

  it("acepta ultimaSincronizacion como string ISO y la propaga tal cual", () => {
    const estado = computeEstadoDatos({
      invoiceCount: 0,
      fielOk: true,
      requests: [req("PENDING", 2026, 6)],
      ultimaSincronizacion: "2026-07-01T08:30:00.000Z",
    });
    expect(estado.ultimaSincronizacion).toBe("2026-07-01T08:30:00.000Z");
  });
});
