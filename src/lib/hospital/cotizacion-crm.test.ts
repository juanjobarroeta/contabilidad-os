import { describe, expect, it } from "vitest";
import { estadoVigente, tableroCrm, urgencia, type CotizacionCrm } from "./cotizacion-crm";

const HOY = new Date(2026, 9, 13, 10);
const dia = (n: number) => new Date(2026, 9, 13 + n, 9);
let k = 0;
const c = (o: Partial<CotizacionCrm>): CotizacionCrm => ({
  id: `c${++k}`, folio: `COT-${k}`, estado: "ENVIADA", procedimiento: "Rinoplastia", total: 1000, createdAt: dia(-10), enviadaAt: dia(-9), cerradaAt: null,
  vigenciaHasta: dia(10), proximoSeguimiento: null, responsableUserId: "u1", medico: null, para: "Ana", contactoTelefono: null, origen: null,
  motivoPerdida: null, perdidaContra: null, ultimoSeguimiento: null, ...o,
});

describe("urgencia", () => {
  it("vencido, hoy, sin fecha, próximo; cerradas y borradores sin fecha no cuentan", () => {
    expect(urgencia(c({ proximoSeguimiento: dia(-1) }), HOY)).toBe("VENCIDO");
    expect(urgencia(c({ proximoSeguimiento: new Date(2026, 9, 13, 18) }), HOY)).toBe("HOY");
    expect(urgencia(c({}), HOY)).toBe("SIN_FECHA");
    expect(urgencia(c({ proximoSeguimiento: dia(3) }), HOY)).toBe("PROXIMO");
    expect(urgencia(c({ estado: "BORRADOR" }), HOY)).toBeNull();
    expect(urgencia(c({ estado: "PERDIDA", proximoSeguimiento: dia(-1) }), HOY)).toBeNull();
  });

  it("una enviada con la vigencia pasada cuenta como vencida, no como abierta", () => {
    const q = c({ vigenciaHasta: dia(-2), proximoSeguimiento: dia(-1) });
    expect(estadoVigente(q, HOY)).toBe("VENCIDA");
    expect(urgencia(q, HOY)).toBeNull();
  });
});

describe("tableroCrm", () => {
  it("KPIs, tasa de cierre, días a cierre, por médico y motivos", () => {
    const m = { id: "m1", nombre: "Dr. Melchor" };
    const t = tableroCrm([
      c({ estado: "ACEPTADA", total: 20000, medico: m, enviadaAt: dia(-10), cerradaAt: dia(-6) }),
      c({ estado: "CONVERTIDA", total: 30000, medico: m, enviadaAt: dia(-8), cerradaAt: dia(-6) }),
      c({ estado: "PERDIDA", total: 25000, medico: m, motivoPerdida: "PRECIO", perdidaContra: "Hospital Ángeles" }),
      c({ estado: "PERDIDA", total: 18000, motivoPerdida: "PRECIO" }),
      c({ estado: "ENVIADA", total: 15000, proximoSeguimiento: dia(-1) }),
      c({ estado: "ENVIADA", total: 9000 }),
      c({ estado: "BORRADOR", total: 5000 }),
    ], HOY);
    expect(t.kpis).toMatchObject({ total: 7, abiertas: 3, montoAbierto: 29000, ganadas: 2, montoGanado: 50000, perdidas: 2, montoPerdido: 43000, tasaCierre: 50, diasPromedioCierre: 3, porSeguir: 3 });
    // La aceptada sin fecha también: hay que agendarla.
    expect(t.porSeguir.map((x) => [x.urgencia, x.estado])).toEqual([["VENCIDO", "ENVIADA"], ["SIN_FECHA", "ACEPTADA"], ["SIN_FECHA", "ENVIADA"]]);
    expect(t.porMedico[0]).toMatchObject({ nombre: "Dr. Melchor", n: 3, ganadas: 2, perdidas: 1, montoGanado: 50000 });
    expect(t.motivosPerdida).toEqual([{ clave: "PRECIO", n: 2 }]);
    expect(t.perdidasContra).toEqual([{ clave: "Hospital Ángeles", n: 1 }]);
  });

  it("sin decididas no hay tasa", () => {
    expect(tableroCrm([c({})], HOY).kpis.tasaCierre).toBeNull();
  });
});
