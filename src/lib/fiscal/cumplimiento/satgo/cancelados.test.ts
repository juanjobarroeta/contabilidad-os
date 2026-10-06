import { describe, expect, it } from "vitest";
import { ventanasCancelados, normalizarCancelado, tipoDesdeEfecto, filaDesdeListado } from "./cancelados";

describe("ventanasCancelados", () => {
  it("semestres del más reciente al más viejo, la actual recortada a hoy, acotado a años", () => {
    const v = ventanasCancelados(new Date(2026, 9, 6), 1, null);
    expect(v.map((x) => x.clave)).toEqual(["2026-S2", "2026-S1", "2025-S2", "2025-S1"]);
    expect(v[0]).toMatchObject({ desde: "2026-07-01", hasta: "2026-10-06" });
    expect(v[1]).toMatchObject({ desde: "2026-01-01", hasta: "2026-06-30" });
  });
  it("se acota al inicio de operaciones", () => {
    const v = ventanasCancelados(new Date(2026, 9, 6), 5, new Date(2025, 8, 3));
    expect(v.map((x) => x.clave)).toEqual(["2026-S2", "2026-S1", "2025-S2"]);
  });
});

describe("listado → fila", () => {
  const crudo = { uuid: "0e729cb9-d901-49fd-b91f-d1e33a56000d", rfCemisor: "CPL8512305I2", razonSocialEmisor: "CASA PLARRE", rfcReceptor: "CPM2307076Z9", razonSocialReceptor: "CENTRO", fechaEmision: "2026-07-31T11:22:56", total: "$1,600.00", efectoDelComprobante: "Ingreso", estadoDeComprobante: "Cancelado", estatusCancelacion: "Cancelable sin aceptación" };
  it("normaliza uuid, RFC y total con símbolos", () => {
    const c = normalizarCancelado(crudo)!;
    expect(c.uuid).toBe("0E729CB9-D901-49FD-B91F-D1E33A56000D");
    expect(c.total).toBe(1600);
    expect(normalizarCancelado({ uuid: "no-es-uuid" })).toBeNull();
  });
  it("recibido Ingreso → EGRESO/I con el emisor como contraparte; emitido Egreso → INGRESO/E", () => {
    const c = normalizarCancelado(crudo)!;
    const f = filaDesdeListado(c, "recibidos", "cmp1");
    expect(f).toMatchObject({ tipo: "EGRESO", tipoSat: "I", status: "CANCELLED", contraparteRfc: "CPL8512305I2", total: 1600, subtotal: 1600 });
    expect(f.fecha.toISOString().startsWith("2026-07-31")).toBe(true);
    expect(tipoDesdeEfecto("Egreso", "emitidos")).toEqual({ tipo: "INGRESO", tipoSat: "E" });
    expect(tipoDesdeEfecto("P", "recibidos")).toEqual({ tipo: "PAGO", tipoSat: "P" });
    expect(tipoDesdeEfecto("Nómina", "emitidos")).toEqual({ tipo: "NOMINA", tipoSat: "N" });
  });
});
