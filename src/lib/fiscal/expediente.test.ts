import { describe, it, expect } from "vitest";
import { filasExpediente, periodoLegible, type EntradasExpediente } from "./expediente";

function entradas(over: Partial<EntradasExpediente> = {}): EntradasExpediente {
  return { declaraciones: [], balanzas: [], envios: [], ...over };
}

const decl = (o: Partial<EntradasExpediente["declaraciones"][number]> = {}) => ({
  id: "d1",
  tipo: "IVA_MENSUAL",
  periodo: "2026-08",
  status: "FILED",
  fechaPresentacion: "2026-09-15T00:00:00.000Z",
  isHistorical: false,
  tienePdf: false,
  acuseUrl: null,
  lineaCaptura: null,
  ...o,
});

describe("filasExpediente", () => {
  it("sólo lista lo PRESENTADO: una calculada no está presentada", () => {
    const f = filasExpediente(entradas({ declaraciones: [decl({ status: "CALCULATED" })] }));
    expect(f).toEqual([]);
  });

  it("dice de dónde sabemos que se presentó", () => {
    const [conPdf] = filasExpediente(entradas({ declaraciones: [decl({ tienePdf: true })] }));
    expect(conPdf.origen).toBe("acuse del SAT guardado");
    expect(conPdf.descarga).toBe("/declaraciones/acuse/d1");

    const [aMano] = filasExpediente(entradas({ declaraciones: [decl({ isHistorical: true })] }));
    expect(aMano.origen).toBe("capturada a mano");
    // Sin documento no se ofrece descarga: un botón a un PDF que no existe
    // es peor que no tenerlo.
    expect(aMano.descarga).toBeNull();
  });

  it("incluye la DIOT y la anual, no sólo las mensuales", () => {
    const f = filasExpediente(
      entradas({
        declaraciones: [
          decl({ id: "a", tipo: "DECLARACION_ANUAL", periodo: "2025" }),
          decl({ id: "b", tipo: "DIOT", periodo: "2026-08" }),
        ],
      })
    );
    expect(f.map((x) => x.etiquetaTipo)).toEqual(["DIOT", "Declaración anual"]);
    expect(f[1].periodoLegible).toBe("ejercicio 2025");
  });

  it("la balanza que el SAT tiene registrada cuenta como presentada", () => {
    const [ce] = filasExpediente(entradas({ balanzas: [{ anio: 2026, mes: 8, cuentas: 42 }] }));
    expect(ce.tipo).toBe("CE_BALANZA");
    expect(ce.periodoLegible).toBe("agosto 2026");
    expect(ce.origen).toContain("42 cuentas");
  });

  it("un envío propio de CE no se duplica si el SAT ya nos devuelve esa balanza", () => {
    const f = filasExpediente(
      entradas({
        balanzas: [{ anio: 2026, mes: 8, cuentas: 10 }],
        envios: [
          { tipoDoc: "BALANZA", periodo: "2026-08", tipoEnvio: "N", fecha: "2026-09-01T00:00:00.000Z" },
          { tipoDoc: "BALANZA", periodo: "2026-09", tipoEnvio: "C", fecha: "2026-10-01T00:00:00.000Z" },
        ],
      })
    );
    expect(f).toHaveLength(2);
    expect(f[0].periodo).toBe("2026-09");
    expect(f[0].origen).toContain("complementaria");
  });

  it("ordena lo más nuevo arriba", () => {
    const f = filasExpediente(
      entradas({
        declaraciones: [
          decl({ id: "v", periodo: "2021-07" }),
          decl({ id: "n", periodo: "2026-08" }),
        ],
      })
    );
    expect(f.map((x) => x.periodo)).toEqual(["2026-08", "2021-07"]);
  });
});

describe("periodoLegible", () => {
  it("distingue mes, ejercicio y cierre anual de la CE", () => {
    expect(periodoLegible("2026-08")).toBe("agosto 2026");
    expect(periodoLegible("2025")).toBe("ejercicio 2025");
    expect(periodoLegible("2025-13")).toBe("cierre del ejercicio 2025");
  });
});
