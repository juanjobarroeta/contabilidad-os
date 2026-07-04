import { describe, it, expect } from "vitest";
import {
  campoMontoPorTipo,
  checkImpuestoMatchGuard,
  confianzaImpuesto,
  elegirMovimientoSugerido,
  esTipoImpuestoConciliable,
  etiquetaImpuesto,
  filtrarCandidatosImpuesto,
  montoEsperadoDeclaracion,
  periodosRecientes,
  scoreCandidatoImpuesto,
  statusTrasDesconciliar,
  TIPOS_IMPUESTO_CONCILIABLES,
} from "./conciliacion-impuestos";

// Decisiones PURAS de la conciliación de pagos de impuestos (SIPARE / línea
// de captura) contra movimientos bancarios. Casos dorados de las reglas v1:
// sólo egresos, tolerancia ±1%, un movimiento por declaración (409 al segundo)
// y reversa determinista del estatus al desconciliar.

const egreso = (monto: number, id = "tx_1", status = "UNMATCHED") => ({ id, monto, status });

// ── Derivación del monto a pagar por tipo ─────────────────────────────────────

describe("campoMontoPorTipo / montoEsperadoDeclaracion", () => {
  it("deriva el campo correcto para cada tipo conciliable", () => {
    expect(campoMontoPorTipo("IVA_MENSUAL")).toBe("ivaPagar");
    expect(campoMontoPorTipo("ISR_PROVISIONAL")).toBe("isrPagar");
    expect(campoMontoPorTipo("RETENCIONES_ISR")).toBe("retencionesIsr");
    expect(campoMontoPorTipo("IMSS_MENSUAL")).toBe("imssCuotas");
    expect(campoMontoPorTipo("IMSS_BIMESTRAL")).toBe("imssCuotas");
  });

  it("lee el monto del campo del tipo (y NO de otro campo)", () => {
    expect(
      montoEsperadoDeclaracion({ tipo: "IVA_MENSUAL", ivaPagar: 1234.56, isrPagar: 999 })
    ).toBe(1234.56);
    expect(
      montoEsperadoDeclaracion({ tipo: "ISR_PROVISIONAL", ivaPagar: 999, isrPagar: 500 })
    ).toBe(500);
    expect(montoEsperadoDeclaracion({ tipo: "RETENCIONES_ISR", retencionesIsr: 800 })).toBe(800);
    expect(montoEsperadoDeclaracion({ tipo: "IMSS_MENSUAL", imssCuotas: 4321 })).toBe(4321);
  });

  it("null y 0 significan «sin monto esperado» (se acepta cualquier monto)", () => {
    expect(montoEsperadoDeclaracion({ tipo: "IMSS_MENSUAL", imssCuotas: null })).toBeNull();
    expect(montoEsperadoDeclaracion({ tipo: "IVA_MENSUAL", ivaPagar: 0 })).toBeNull();
    expect(montoEsperadoDeclaracion({ tipo: "ISR_PROVISIONAL" })).toBeNull();
  });

  it("un tipo no conciliable (DIOT/ANUAL) no tiene monto esperado", () => {
    expect(montoEsperadoDeclaracion({ tipo: "DIOT", ivaPagar: 100 })).toBeNull();
    expect(esTipoImpuestoConciliable("DIOT")).toBe(false);
    expect(esTipoImpuestoConciliable("DECLARACION_ANUAL")).toBe(false);
    for (const t of TIPOS_IMPUESTO_CONCILIABLES) expect(esTipoImpuestoConciliable(t)).toBe(true);
  });
});

// ── Guard del match ───────────────────────────────────────────────────────────

describe("checkImpuestoMatchGuard", () => {
  const ivaDecl = { id: "d_1", tipo: "IVA_MENSUAL", ivaPagar: 10_000 };

  it("acepta un egreso UNMATCHED con monto exacto", () => {
    const r = checkImpuestoMatchGuard(ivaDecl, [], egreso(-10_000));
    expect(r).toEqual({ ok: true, montoEsperado: 10_000 });
  });

  it("acepta dentro de la tolerancia del 1% (por arriba y por abajo)", () => {
    expect(checkImpuestoMatchGuard(ivaDecl, [], egreso(-10_100)).ok).toBe(true); // +1% exacto
    expect(checkImpuestoMatchGuard(ivaDecl, [], egreso(-9_900)).ok).toBe(true); // −1% exacto
  });

  it("RECHAZA con 422 apenas fuera de la tolerancia del 1%", () => {
    const r = checkImpuestoMatchGuard(ivaDecl, [], egreso(-10_101));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.error).toContain("no coincide");
    }
    expect(checkImpuestoMatchGuard(ivaDecl, [], egreso(-9_899)).ok).toBe(false);
  });

  it("sin monto esperado (IMSS sin estimado) acepta cualquier monto", () => {
    const imss = { id: "d_2", tipo: "IMSS_MENSUAL", imssCuotas: null };
    const r = checkImpuestoMatchGuard(imss, [], egreso(-7_777.77));
    expect(r).toEqual({ ok: true, montoEsperado: null });
  });

  it("RECHAZA con 422 un depósito (sólo egresos pagan impuestos)", () => {
    const r = checkImpuestoMatchGuard(ivaDecl, [], egreso(10_000));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.error).toContain("depósito");
    }
  });

  it("RECHAZA con 422 un monto cero", () => {
    expect(checkImpuestoMatchGuard(ivaDecl, [], egreso(0)).ok).toBe(false);
  });

  it("RECHAZA con 409 un movimiento que no está UNMATCHED", () => {
    const r = checkImpuestoMatchGuard(ivaDecl, [], egreso(-10_000, "tx_1", "MATCHED"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it("RECHAZA con 409 el SEGUNDO movimiento sobre la misma declaración (v1: uno por línea de captura)", () => {
    const r = checkImpuestoMatchGuard(ivaDecl, [{ id: "tx_previo" }], egreso(-10_000, "tx_2"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.error).toContain("ya está conciliada con otro movimiento");
    }
  });

  it("re-conciliar el MISMO movimiento no cuenta como segundo movimiento", () => {
    // El caller exige UNMATCHED, así que en la práctica no ocurre; la regla
    // pura es idempotente por id de todos modos.
    const r = checkImpuestoMatchGuard(ivaDecl, [{ id: "tx_1" }], egreso(-10_000, "tx_1"));
    expect(r.ok).toBe(true);
  });

  it("RECHAZA con 422 un tipo no conciliable (DIOT)", () => {
    const r = checkImpuestoMatchGuard({ id: "d_3", tipo: "DIOT" }, [], egreso(-10_000));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });
});

// ── Reversa del unmatch ───────────────────────────────────────────────────────

describe("statusTrasDesconciliar", () => {
  it("con evidencia de presentación regresa a FILED", () => {
    expect(statusTrasDesconciliar({ acuseUrl: "https://…/acuse.pdf" })).toBe("FILED");
    expect(statusTrasDesconciliar({ acusePdfNombre: "acuse.pdf" })).toBe("FILED");
    expect(statusTrasDesconciliar({ lineaCaptura: "0219…" })).toBe("FILED");
  });

  it("sin evidencia regresa a CALCULATED", () => {
    expect(statusTrasDesconciliar({})).toBe("CALCULATED");
    expect(statusTrasDesconciliar({ acuseUrl: null, acusePdfNombre: null, lineaCaptura: null })).toBe("CALCULATED");
    expect(statusTrasDesconciliar({ lineaCaptura: "" })).toBe("CALCULATED");
  });
});

// ── Candidatos: periodos, filtro y scoring ────────────────────────────────────

describe("periodosRecientes", () => {
  it("devuelve el mes del movimiento y los 3 anteriores (n = 4)", () => {
    expect(periodosRecientes(new Date(2026, 1, 17))).toEqual([
      "2026-02", "2026-01", "2025-12", "2025-11",
    ]);
  });

  it("cruza el cambio de año", () => {
    expect(periodosRecientes(new Date(2026, 0, 5), 3)).toEqual(["2026-01", "2025-12", "2025-11"]);
  });
});

describe("filtrarCandidatosImpuesto", () => {
  const base = { periodo: "2026-01", status: "CALCULATED" };
  it("excluye pagadas, tipos no conciliables e IVA/ISR sin monto a pagar; conserva IMSS sin estimado", () => {
    const decls = [
      { ...base, id: "a", tipo: "IVA_MENSUAL", ivaPagar: 5000 },
      { ...base, id: "b", tipo: "IVA_MENSUAL", ivaPagar: 5000, status: "PAID" }, // pagada
      { ...base, id: "c", tipo: "DIOT" }, // informativa
      { ...base, id: "d", tipo: "IVA_MENSUAL", ivaPagar: 0 }, // saldo a favor: nada que pagar
      { ...base, id: "e", tipo: "ISR_PROVISIONAL", isrPagar: null }, // sin ISR a cargo
      { ...base, id: "f", tipo: "IMSS_MENSUAL", imssCuotas: null }, // IMSS sin estimado: SÍ
      { ...base, id: "g", tipo: "RETENCIONES_ISR", retencionesIsr: 900 },
    ];
    expect(filtrarCandidatosImpuesto(decls).map((d) => d.id)).toEqual(["a", "f", "g"]);
  });
});

describe("scoreCandidatoImpuesto / confianzaImpuesto", () => {
  const limite = new Date("2026-02-17T00:00:00Z");
  const tx = (monto: number, fecha: string) => ({ monto, fecha: new Date(`${fecha}T00:00:00Z`) });

  it("monto exacto + pago el día límite = confianza alta (130)", () => {
    const s = scoreCandidatoImpuesto(
      { montoEsperado: 10_000, fechaLimitePago: limite },
      tx(-10_000, "2026-02-17")
    );
    expect(s).toBe(130);
    expect(confianzaImpuesto(s)).toBe("alta");
  });

  it("monto dentro del 1% + 3 días de la fecha límite = media (40 + 20)", () => {
    const s = scoreCandidatoImpuesto(
      { montoEsperado: 10_000, fechaLimitePago: limite },
      tx(-10_090, "2026-02-14")
    );
    expect(s).toBe(60);
    expect(confianzaImpuesto(s)).toBe("media");
  });

  it("sin monto esperado sólo puntúa la fecha (IMSS sin estimado)", () => {
    const s = scoreCandidatoImpuesto(
      { montoEsperado: null, fechaLimitePago: limite },
      tx(-8_000, "2026-02-16")
    );
    expect(s).toBe(30);
    expect(confianzaImpuesto(s)).toBe("baja");
  });

  it("sin fecha límite sólo puntúa el monto", () => {
    const s = scoreCandidatoImpuesto(
      { montoEsperado: 10_000, fechaLimitePago: null },
      tx(-10_000, "2026-02-17")
    );
    expect(s).toBe(100);
    expect(confianzaImpuesto(s)).toBe("alta");
  });

  it("fuera de tolerancia y lejos de la fecha = 0 (baja)", () => {
    const s = scoreCandidatoImpuesto(
      { montoEsperado: 10_000, fechaLimitePago: limite },
      tx(-12_000, "2026-03-20")
    );
    expect(s).toBe(0);
  });
});

// ── Etiquetas ─────────────────────────────────────────────────────────────────

describe("etiquetaImpuesto", () => {
  it("etiqueta cada tipo con su periodo humano", () => {
    expect(etiquetaImpuesto("IVA_MENSUAL", "2026-01")).toBe("IVA enero 2026");
    expect(etiquetaImpuesto("ISR_PROVISIONAL", "2026-03")).toBe("ISR provisional marzo 2026");
    expect(etiquetaImpuesto("RETENCIONES_ISR", "2026-12")).toBe("Retenciones ISR diciembre 2026");
    expect(etiquetaImpuesto("IMSS_MENSUAL", "2026-01")).toBe("IMSS mensual enero 2026 (SIPARE)");
  });

  it("el bimestral se llavea con el mes que CIERRA el bimestre", () => {
    expect(etiquetaImpuesto("IMSS_BIMESTRAL", "2026-02")).toBe("RCV e Infonavit ene-feb 2026 (SIPARE)");
    expect(etiquetaImpuesto("IMSS_BIMESTRAL", "2026-12")).toBe("RCV e Infonavit nov-dic 2026 (SIPARE)");
  });
});

// ── Sugerencia desde el lado IMSS/declaración ─────────────────────────────────

describe("elegirMovimientoSugerido", () => {
  const limite = new Date("2026-02-17T00:00:00Z");
  const mov = (id: string, monto: number, fecha: string, status = "UNMATCHED") => ({
    id, monto, status, fecha: new Date(`${fecha}T00:00:00Z`), descripcion: `mov ${id}`,
  });

  it("elige el egreso UNMATCHED dentro de ±3 días y ±1% del objetivo", () => {
    const elegido = elegirMovimientoSugerido(10_000, limite, [
      mov("a", -10_000, "2026-02-16"),
      mov("b", -5_000, "2026-02-16"), // fuera de tolerancia de monto
      mov("c", -10_000, "2026-02-01"), // fuera de ventana de fecha
    ]);
    expect(elegido?.id).toBe("a");
  });

  it("desempata por cercanía de monto y luego de fecha", () => {
    const elegido = elegirMovimientoSugerido(10_000, limite, [
      mov("lejano", -10_050, "2026-02-15"),
      mov("exacto", -10_000, "2026-02-14"),
    ]);
    expect(elegido?.id).toBe("exacto");
    const porFecha = elegirMovimientoSugerido(10_000, limite, [
      mov("d3", -10_000, "2026-02-14"),
      mov("d1", -10_000, "2026-02-16"),
    ]);
    expect(porFecha?.id).toBe("d1");
  });

  it("ignora depósitos y movimientos que no están UNMATCHED", () => {
    expect(
      elegirMovimientoSugerido(10_000, limite, [
        mov("deposito", 10_000, "2026-02-17"),
        mov("conciliado", -10_000, "2026-02-17", "MATCHED"),
      ])
    ).toBeNull();
  });

  it("null sin objetivo (> 0) o sin candidatos", () => {
    expect(elegirMovimientoSugerido(0, limite, [mov("a", -10, "2026-02-17")])).toBeNull();
    expect(elegirMovimientoSugerido(10_000, limite, [])).toBeNull();
  });
});
