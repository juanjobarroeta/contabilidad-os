import { describe, it, expect } from "vitest";
import {
  diffSalud,
  evaluarSalud,
  peorEstado,
  rankDeltas,
  requiereAtencion,
  type DimensionSalud,
  type HechosSalud,
} from "./evaluar";
import { CLAVES_SALUD } from "./claves";

const HOY = new Date("2026-09-14T12:00:00Z");
const hace = (dias: number) => new Date(HOY.getTime() - dias * 24 * 60 * 60 * 1000);
const dentroDe = (dias: number) => new Date(HOY.getTime() + dias * 24 * 60 * 60 * 1000);

/** Una empresa al corriente en todo: el punto de partida de cada caso. */
function sana(extra: Partial<HechosSalud> = {}): HechosSalud {
  return {
    companyId: "c1",
    autoSyncEnabled: true,
    lastAutoSyncAt: hace(1),
    satBackfillCompletedAt: hace(200),
    solicitudesFallidas: 0,
    tieneFiel: true,
    fielVigencia: dentroDe(400),
    csdVigencia: dentroDe(400),
    opinionResultado: "POSITIVA",
    opinionFetchedAt: hace(3),
    opinionMotivos: 0,
    declaracionesFaltantes: 0,
    declaracionesCriticas: 0,
    ceSatSyncEn: hace(5),
    ceSatSyncOk: true,
    concilia: true,
    movimientosSinConciliar: 0,
    movimientosSinConciliarViejos: 0,
    hallazgosError: 0,
    hallazgosWarn: 0,
    ...extra,
  };
}

const de = (ds: DimensionSalud[], clave: string) => ds.find((d) => d.clave === clave)!;

describe("evaluarSalud", () => {
  it("una empresa al corriente sale ok en todas las dimensiones", () => {
    const ds = evaluarSalud(sana(), HOY);
    expect(ds.map((d) => d.clave).sort()).toEqual([...CLAVES_SALUD].sort());
    expect(ds.every((d) => d.estado === "ok")).toBe(true);
    expect(peorEstado(ds)).toBe("ok");
  });

  it("devuelve SIEMPRE las ocho dimensiones, aunque estén bien", () => {
    // Si una dimensión sana desapareciera del arreglo, el diff de mañana no
    // podría distinguir «mejoró» de «ya no se mide».
    expect(evaluarSalud(sana(), HOY)).toHaveLength(CLAVES_SALUD.length);
    expect(evaluarSalud(sana({ autoSyncEnabled: false, tieneFiel: false }), HOY)).toHaveLength(
      CLAVES_SALUD.length,
    );
  });

  it("no sincronizar tres semanas bloquea; una semana sólo pide atención", () => {
    expect(de(evaluarSalud(sana({ lastAutoSyncAt: hace(25) }), HOY), "datos_sat").estado).toBe("bloquea");
    expect(de(evaluarSalud(sana({ lastAutoSyncAt: hace(9) }), HOY), "datos_sat").estado).toBe("atencion");
    expect(de(evaluarSalud(sana({ lastAutoSyncAt: hace(2) }), HOY), "datos_sat").estado).toBe("ok");
  });

  it("solicitudes fallidas piden atención aunque la sincronización sea de ayer", () => {
    const d = de(evaluarSalud(sana({ solicitudesFallidas: 3 }), HOY), "datos_sat");
    expect(d.estado).toBe("atencion");
    expect(d.detalle).toContain("3 solicitudes");
  });

  it("la e.firma vencida bloquea y la que está por vencer sólo avisa", () => {
    expect(de(evaluarSalud(sana({ fielVigencia: hace(2) }), HOY), "credenciales").estado).toBe("bloquea");
    expect(de(evaluarSalud(sana({ fielVigencia: dentroDe(10) }), HOY), "credenciales").estado).toBe("atencion");
    expect(de(evaluarSalud(sana({ fielVigencia: dentroDe(90) }), HOY), "credenciales").estado).toBe("ok");
  });

  it("sin e.firma es «sin datos», no «ok»: no saber es un estado", () => {
    const d = de(evaluarSalud(sana({ tieneFiel: false, fielVigencia: null }), HOY), "credenciales");
    expect(d.estado).toBe("sin_datos");
  });

  it("una opinión negativa bloquea; una vieja sólo pide refrescarla", () => {
    expect(de(evaluarSalud(sana({ opinionResultado: "NEGATIVA", opinionMotivos: 2 }), HOY), "cumplimiento").estado).toBe("bloquea");
    expect(de(evaluarSalud(sana({ opinionFetchedAt: hace(60) }), HOY), "cumplimiento").estado).toBe("atencion");
    expect(de(evaluarSalud(sana({ opinionResultado: null, opinionFetchedAt: null }), HOY), "cumplimiento").estado).toBe("sin_datos");
  });

  it("un acuse crítico faltante bloquea; uno normal pide atención", () => {
    expect(de(evaluarSalud(sana({ declaracionesFaltantes: 4, declaracionesCriticas: 1 }), HOY), "declaraciones").estado).toBe("bloquea");
    expect(de(evaluarSalud(sana({ declaracionesFaltantes: 2 }), HOY), "declaraciones").estado).toBe("atencion");
  });

  it("la CE nunca revisada es «sin datos» y la corrida fallida pide atención", () => {
    expect(de(evaluarSalud(sana({ ceSatSyncEn: null, ceSatSyncOk: null }), HOY), "contabilidad_electronica").estado).toBe("sin_datos");
    expect(de(evaluarSalud(sana({ ceSatSyncOk: false }), HOY), "contabilidad_electronica").estado).toBe("atencion");
  });

  it("una empresa sin banco no se juzga en bancos, pero sí en IVA en flujo", () => {
    const ds = evaluarSalud(sana({ concilia: false, movimientosSinConciliar: 0 }), HOY);
    expect(de(ds, "bancos").estado).toBe("sin_datos");
    // Sin conciliación, el IVA de PUE se acredita por suposición: eso es lo que
    // se declara sin prueba de pago, y por eso no puede salir en verde.
    expect(de(ds, "iva_flujo").estado).toBe("atencion");
    expect(de(ds, "iva_flujo").metricas.modo).toBe("SUPUESTO_PAGADO");
  });

  it("los movimientos viejos sin conciliar pesan; los recientes no", () => {
    expect(de(evaluarSalud(sana({ movimientosSinConciliar: 30, movimientosSinConciliarViejos: 4 }), HOY), "bancos").estado).toBe("atencion");
    expect(de(evaluarSalud(sana({ movimientosSinConciliar: 30 }), HOY), "bancos").estado).toBe("ok");
  });

  it("peorEstado se queda con la dimensión más grave", () => {
    const ds = evaluarSalud(sana({ fielVigencia: hace(1), declaracionesFaltantes: 2 }), HOY);
    expect(peorEstado(ds)).toBe("bloquea");
  });
});

describe("diffSalud", () => {
  it("la primera corrida sólo avisa lo que no está bien", () => {
    const next = evaluarSalud(sana({ declaracionesFaltantes: 2 }), HOY);
    const deltas = diffSalud(null, next);
    expect(deltas.map((d) => d.clave)).toEqual(["declaraciones"]);
    expect(deltas[0].direccion).toBe("nuevo");
    expect(deltas[0].de).toBeNull();
  });

  it("un problema que sigue igual que ayer NO vuelve a avisar", () => {
    // Es la regla que separa un aviso de un ruido diario.
    const ayer = evaluarSalud(sana({ declaracionesFaltantes: 2 }), HOY);
    const hoy = evaluarSalud(sana({ declaracionesFaltantes: 2 }), HOY);
    expect(diffSalud(ayer, hoy)).toEqual([]);
  });

  it("empeorar avisa una sola vez, en el día que cruzó", () => {
    const ayer = evaluarSalud(sana({ declaracionesFaltantes: 2 }), HOY);
    const hoy = evaluarSalud(sana({ declaracionesFaltantes: 3, declaracionesCriticas: 1 }), HOY);
    const deltas = diffSalud(ayer, hoy);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ clave: "declaraciones", direccion: "empeoro", de: "atencion", a: "bloquea" });
    // Y al día siguiente, con el mismo problema, ya no avisa.
    expect(diffSalud(hoy, hoy)).toEqual([]);
  });

  it("resolver algo emite «mejoro», y sólo si antes estaba mal", () => {
    const ayer = evaluarSalud(sana({ declaracionesFaltantes: 2 }), HOY);
    const hoy = evaluarSalud(sana(), HOY);
    const deltas = diffSalud(ayer, hoy);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ direccion: "mejoro", de: "atencion", a: "ok" });
    // Dos días seguidos bien: nada que decir.
    expect(diffSalud(hoy, hoy)).toEqual([]);
  });

  it("una dimensión nueva en un snapshot viejo entra como «nuevo», no como «empeoro»", () => {
    const ayerSinIva = evaluarSalud(sana({ concilia: false }), HOY).filter((d) => d.clave !== "iva_flujo");
    const hoy = evaluarSalud(sana({ concilia: false }), HOY);
    const delta = diffSalud(ayerSinIva, hoy).find((d) => d.clave === "iva_flujo");
    expect(delta?.direccion).toBe("nuevo");
  });
});

describe("rankDeltas y requiereAtencion", () => {
  it("lo que bloquea va primero y las mejoras no entran", () => {
    const ayer = evaluarSalud(sana(), HOY);
    const hoy = evaluarSalud(sana({ fielVigencia: hace(1), movimientosSinConciliarViejos: 5 }), HOY);
    const orden = rankDeltas(diffSalud(ayer, hoy));
    expect(orden[0].clave).toBe("credenciales");
    expect(orden.every((d) => d.direccion !== "mejoro")).toBe(true);
  });

  it("una empresa bloqueada requiere atención aunque no haya cambiado nada hoy", () => {
    const ds = evaluarSalud(sana({ fielVigencia: hace(5) }), HOY);
    expect(requiereAtencion(ds, diffSalud(ds, ds))).toBe(true);
  });

  it("una empresa igual de bien que ayer NO requiere atención", () => {
    // Éste es el caso que hace viable la pasada diaria: la mayoría de los días,
    // la mayoría de las empresas no cambió y no cuesta nada.
    const ds = evaluarSalud(sana(), HOY);
    expect(requiereAtencion(ds, diffSalud(ds, ds))).toBe(false);
  });

  it("una empresa que sólo mejoró tampoco requiere atención", () => {
    const ayer = evaluarSalud(sana({ declaracionesFaltantes: 2 }), HOY);
    const hoy = evaluarSalud(sana(), HOY);
    expect(requiereAtencion(hoy, diffSalud(ayer, hoy))).toBe(false);
  });
});
