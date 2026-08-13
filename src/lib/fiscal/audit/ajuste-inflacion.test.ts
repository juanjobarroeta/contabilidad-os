import { describe, expect, it } from "vitest";
import {
  auditarAjusteInflacion,
  TOLERANCIA_DESCUADRE,
  UMBRAL_MONTO,
  type AjusteInflacionPendiente,
} from "./ajuste-inflacion";

const base: AjusteInflacionPendiente = {
  companyId: "c1",
  ejercicio: 2025,
  tipoPersona: "PM",
  calculable: true,
  acumulable: 34_000,
  deducible: 0,
  mesesSinPostear: [],
  statusDeclaracion: null,
  descuadreRelativo: 0,
};

const con = (over: Partial<AjusteInflacionPendiente>) => auditarAjusteInflacion({ ...base, ...over });

describe("auditarAjusteInflacion", () => {
  it("levanta el ajuste acumulable material de una PM", () => {
    const [h] = con({});
    expect(h.checkClave).toBe("anual.ajuste_inflacion_pendiente");
    expect(h.severidad).toBe("warn");
    expect(h.mensaje).toMatch(/ACUMULABLE/);
    expect(h.fundamento).toEqual({ ley: "LISR", articulo: "44" });
  });

  it("distingue el deducible del acumulable en el mensaje", () => {
    const [h] = con({ acumulable: 0, deducible: 40_000 });
    expect(h.mensaje).toMatch(/DEDUCIBLE/);
    expect(h.mensaje).not.toMatch(/ACUMULABLE/);
  });

  it("el ajuste por inflación es del Título II: una PF nunca lo ve", () => {
    expect(con({ tipoPersona: "PF" })).toEqual([]);
  });

  it("sin INPC no reclama una cifra que no puede determinar", () => {
    expect(con({ calculable: false })).toEqual([]);
  });

  it("con meses sin postear calla: el promedio anual saldría incompleto", () => {
    // Preferimos no decir nada a levantar un hallazgo con una cifra mal formada
    // — un falso positivo aquí manda a alguien a presentar una complementaria.
    expect(con({ mesesSinPostear: [11, 12] })).toEqual([]);
  });

  it("con el balance descuadrado NO habla, por grande que sea la cifra", () => {
    // Salió de producción: una empresa con el libro descuadrado producía un
    // ajuste de ocho cifras a partir de cuatro cuentas con saldos de miles de
    // millones. Si la ecuación contable no cuadra, esos saldos no describen a
    // la empresa y el "ajuste" es ruido con dos decimales — y este hallazgo
    // puede mandar a alguien a presentar una complementaria.
    expect(con({ descuadreRelativo: 0.5, acumulable: 15_649_058 })).toEqual([]);
    expect(con({ descuadreRelativo: null })).toEqual([]);
  });

  it("un descuadre de redondeo no impide el hallazgo", () => {
    // La tolerancia existe para el centavo, no para tapar un libro roto.
    expect(con({ descuadreRelativo: 0.0001 })).toHaveLength(1);
    expect(con({ descuadreRelativo: TOLERANCIA_DESCUADRE })).toHaveLength(1);
    expect(con({ descuadreRelativo: TOLERANCIA_DESCUADRE * 2 })).toEqual([]);
  });

  it("por debajo del umbral es ruido, no hallazgo", () => {
    expect(con({ acumulable: UMBRAL_MONTO - 1 })).toEqual([]);
    expect(con({ acumulable: UMBRAL_MONTO })).toHaveLength(1);
  });

  it("si la anual ya se presentó sube a error y sugiere complementaria", () => {
    const [h] = con({ statusDeclaracion: "FILED" });
    expect(h.severidad).toBe("error");
    expect(h.sugerencia).toMatch(/complementaria/i);
  });

  it("una anual apenas calculada sigue siendo warn (aún se puede corregir)", () => {
    const [h] = con({ statusDeclaracion: "CALCULATED" });
    expect(h.severidad).toBe("warn");
  });

  it("dedupea por ejercicio: no se acumula un hallazgo por corrida", () => {
    const [a] = con({});
    const [b] = con({ acumulable: 99_000 });
    expect(a.dedupeRef).toBe(b.dedupeRef);
    expect(a.dedupeRef).toContain("2025");
    // Otro ejercicio SÍ es otro hallazgo.
    const [c] = con({ ejercicio: 2024 });
    expect(c.dedupeRef).not.toBe(a.dedupeRef);
  });
});
