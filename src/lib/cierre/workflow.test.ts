import { describe, it, expect } from "vitest";
import type { ReadinessResult } from "../contabilidad/ce-readiness";
import type { ChecklistDeclaracion, ChecklistItem } from "../fiscal/checklist-declaracion";
import {
  decidirPasos,
  periodosEnJuego,
  PASOS,
  ORDEN_PASOS,
  esClavePaso,
  type ContextoEmpresa,
  type ExtrasCierre,
  type HechosCierre,
} from "./workflow";

// ─────────────────────────────────────────────────────────────────────────────
// Tests del corazón puro: dado lo que los motores ya dijeron (readiness,
// checklist, extras), el estado de cada paso, la propagación `espera` y el
// hash de evidencia. Sin DB.
// ─────────────────────────────────────────────────────────────────────────────

const HOY = new Date("2026-09-05T12:00:00Z");

function ctx(over: Partial<ContextoEmpresa> = {}): ContextoEmpresa {
  return {
    regimenFiscal: "601",
    requiereBalance: true,
    tieneEmpleados: true,
    tieneDiot: true,
    tieneBanco: true,
    year: 2026,
    month: 8,
    ...over,
  };
}

function readiness(over: Partial<Record<string, "ok" | "warn" | "error">> = {}): ReadinessResult {
  const estados = { cfdis: "ok", banco: "ok", sin_clasificar: "ok", cuadre: "ok", posteo: "ok", ...over } as Record<
    string,
    "ok" | "warn" | "error"
  >;
  const titulos: Record<string, string> = {
    cfdis: estados.cfdis === "ok" ? "CFDIs del periodo sincronizados" : "Sin CFDIs del periodo",
    banco: estados.banco === "ok" ? "Datos bancarios del periodo presentes" : "Sin movimientos bancarios del periodo",
    sin_clasificar: estados.sin_clasificar === "ok" ? "Todos los movimientos clasificados" : "43 movimientos sin clasificar",
    cuadre: estados.cuadre === "ok" ? "La balanza cuadra" : "La balanza no cuadra",
    posteo: estados.posteo === "ok" ? "Mes cerrado" : "Mes preliminar",
  };
  return {
    status: "lista",
    resumen: "",
    checks: Object.keys(estados).map((clave) => ({ clave, estado: estados[clave], titulo: titulos[clave], detalle: "" })),
  };
}

const ITEMS: Array<[string, string]> = [
  ["apertura", "El punto de partida fiscal (saldo a favor inicial, pérdidas por amortizar, coeficiente y obligaciones) está revisado y confirmado."],
  ["sincronizacion-sat", "Los CFDI emitidos y recibidos del periodo ya se descargaron del SAT."],
  ["cadena-declaraciones", "La cadena de arrastre está íntegra: los meses anteriores con actividad tienen declaración guardada."],
  ["conciliacion-bancaria", "Todos los movimientos bancarios del mes están conciliados."],
  ["complementos-por-emitir", "No hay cobros PPD del mes pendientes de complemento de pago (REP)."],
  ["complementos-proveedores", "Los gastos PPD pagados en el mes ya cuentan con el REP del proveedor."],
  ["posicion-calculada", "IVA a pagar $12,000.00 · ISR provisional a pagar $8,000.00."],
  ["diot", "La DIOT del periodo ya está presentada."],
  ["nomina", "Las 2 corrida(s) de nómina del mes están timbradas."],
  ["cuotas-imss", "Las cuotas IMSS del periodo están pagadas."],
  ["declaracion-periodo", "La declaración del periodo ya está presentada."],
  ["fecha-limite", "Presentada. La fecha límite del periodo era el 17 de septiembre de 2026."],
];

function checklist(over: Record<string, Partial<ChecklistItem>> = {}): ChecklistDeclaracion {
  const items: ChecklistItem[] = ITEMS.map(([clave, detalle]) => ({
    clave,
    titulo: clave,
    estado: "listo",
    detalle,
    accionUrl: "/impuestos",
    ...(over[clave] ?? {}),
  }));
  return {
    periodo: "2026-08",
    year: 2026,
    month: 8,
    fechaLimite: "2026-09-17",
    diasRestantes: 12,
    vencida: false,
    items,
    resumen: { listos: items.length, pendientes: 0, atencion: 0, noAplica: 0, total: items.length },
  };
}

function extras(over: Partial<ExtrasCierre> = {}): ExtrasCierre {
  return {
    cfdiFaltantes: 0,
    cuentasBanco: 2,
    cuentasSinEstado: 0,
    cuentasFirmadas: 2,
    empleadosActivos: 5,
    empleadosSinRecibo: 0,
    idsePendientes: 0,
    hallazgosCriticos: 0,
    hallazgosEfos: 0,
    pagoConciliado: true,
    declaracionPagada: true,
    ...over,
  };
}

function hechos(over: Partial<HechosCierre> = {}): HechosCierre {
  return { ctx: ctx(), hoy: HOY, readiness: readiness(), checklist: checklist(), extras: extras(), ...over };
}

const estadoDe = (h: HechosCierre, clave: string) => decidirPasos(h).find((p) => p.clave === clave)!;

describe("definición del workflow", () => {
  it("tiene doce pasos en orden y las dependencias apuntan a pasos anteriores", () => {
    expect(ORDEN_PASOS).toHaveLength(12);
    for (const p of PASOS) {
      for (const d of p.dependeDe) {
        expect(ORDEN_PASOS.indexOf(d)).toBeLessThan(ORDEN_PASOS.indexOf(p.clave));
      }
    }
    expect(esClavePaso("banco")).toBe(true);
    expect(esClavePaso("bancos")).toBe(false);
  });
});

describe("decidirPasos — empresa sana", () => {
  it("todo listo cuando los motores están en verde", () => {
    const pasos = decidirPasos(hechos());
    expect(pasos.map((p) => p.estadoCalculado)).toEqual(Array(12).fill("listo"));
    expect(estadoDe(hechos(), "entregables").detalle).toBe("XML del periodo listos");
    expect(estadoDe(hechos(), "declaracion").fechaLimite).toBe("2026-09-17");
  });

  it("no_aplica en nómina, IMSS y DIOT cuando la empresa no los tiene", () => {
    const h = hechos({ ctx: ctx({ tieneEmpleados: false, tieneDiot: false }) });
    expect(estadoDe(h, "nomina").estadoCalculado).toBe("no_aplica");
    expect(estadoDe(h, "imss").estadoCalculado).toBe("no_aplica");
    expect(estadoDe(h, "diot").estadoCalculado).toBe("no_aplica");
    // Declaración depende de DIOT: un no_aplica no bloquea.
    expect(estadoDe(h, "declaracion").estadoCalculado).toBe("listo");
    expect(estadoDe(h, "entregables").estadoCalculado).toBe("listo");
  });
});

describe("decidirPasos — el número que importa y la propagación", () => {
  it("banco con movimientos sin clasificar → atención con la cifra del motor", () => {
    const h = hechos({
      readiness: readiness({ sin_clasificar: "warn" }),
      checklist: checklist({ "conciliacion-bancaria": { estado: "pendiente", detalle: "43 movimiento(s) bancario(s) del mes sin conciliar. Concílialos." } }),
    });
    const banco = estadoDe(h, "banco");
    expect(banco.estadoCalculado).toBe("atencion");
    expect(banco.detalle).toBe("43 movimientos sin clasificar");
    expect(banco.cta.href).toContain("/bancos");
  });

  it("sin CFDIs → SAT bloquea y TODO lo demás espera", () => {
    const h = hechos({ readiness: readiness({ cfdis: "error" }) });
    const pasos = decidirPasos(h);
    expect(estadoDe(h, "sat").estadoCalculado).toBe("bloquea");
    for (const p of pasos) {
      if (p.clave === "apertura" || p.clave === "sat") continue;
      expect(p.estadoCalculado, p.clave).toBe("espera");
    }
  });

  it("sin banco en persona moral → banco bloquea; contabilidad y declaración esperan, nómina no", () => {
    const h = hechos({ readiness: readiness({ banco: "error" }) });
    expect(estadoDe(h, "banco").estadoCalculado).toBe("bloquea");
    expect(estadoDe(h, "contabilidad").estadoCalculado).toBe("espera");
    expect(estadoDe(h, "complementos").estadoCalculado).toBe("espera");
    expect(estadoDe(h, "declaracion").estadoCalculado).toBe("espera");
    expect(estadoDe(h, "nomina").estadoCalculado).toBe("listo");
    expect(estadoDe(h, "entregables").estadoCalculado).toBe("espera");
  });

  it("cuentas sin estado de cuenta: error en PM (bloquea), aviso en régimen sin balance", () => {
    const pm = hechos({ extras: extras({ cuentasSinEstado: 1 }) });
    expect(estadoDe(pm, "banco").estadoCalculado).toBe("bloquea");
    expect(estadoDe(pm, "banco").detalle).toBe("1 de 2 cuentas sin estado de cuenta del mes");
    const pf = hechos({ ctx: ctx({ requiereBalance: false, regimenFiscal: "626" }), extras: extras({ cuentasSinEstado: 1 }) });
    expect(estadoDe(pf, "banco").estadoCalculado).toBe("atencion");
  });

  it("69-B abierto → riesgos en atención (no bloquea el cierre) con su CTA", () => {
    const h = hechos({ extras: extras({ hallazgosEfos: 2 }) });
    const r = estadoDe(h, "revision");
    expect(r.estadoCalculado).toBe("atencion");
    expect(r.detalle).toBe("2 coincidencias abiertas en la lista 69-B");
    expect(r.cta.href).toContain("/hallazgos");
  });

  it("empleado activo sin recibo → nómina en atención, IMSS sigue evaluándose", () => {
    const h = hechos({ extras: extras({ empleadosSinRecibo: 1 }) });
    expect(estadoDe(h, "nomina").estadoCalculado).toBe("atencion");
    expect(estadoDe(h, "nomina").detalle).toBe("1 empleado activo sin recibo timbrado en el mes");
    expect(estadoDe(h, "imss").estadoCalculado).toBe("listo");
  });

  it("declaración vencida sin presentar → atención con la primera oración del checklist", () => {
    const h = hechos({
      checklist: checklist({
        "declaracion-periodo": { estado: "pendiente", detalle: "La declaración está calculada y guardada; falta presentarla al SAT y capturar el acuse." },
        "fecha-limite": { estado: "atencion", detalle: "La fecha límite (17 de septiembre de 2026) venció hace 3 día(s). Presenta cuanto antes." },
      }),
      extras: extras({ pagoConciliado: false, declaracionPagada: false }),
    });
    const d = estadoDe(h, "declaracion");
    expect(d.estadoCalculado).toBe("atencion");
    expect(d.detalle).toBe("La declaración está calculada y guardada");
    expect(estadoDe(h, "entregables").estadoCalculado).toBe("espera");
  });

  it("sin motores → sin_datos (no inventa un verde)", () => {
    const h = hechos({ readiness: null, checklist: null });
    expect(estadoDe(h, "impuestos").estadoCalculado).toBe("sin_datos");
    expect(estadoDe(h, "apertura").estadoCalculado).toBe("sin_datos");
  });
});

describe("decidirPasos — evidencia", () => {
  it("el hash cambia cuando cambia la cifra y no cuando cambia otro paso", () => {
    const a = decidirPasos(hechos());
    const b = decidirPasos(hechos({ readiness: readiness({ sin_clasificar: "warn" }) }));
    const h = (pasos: typeof a, clave: string) => pasos.find((p) => p.clave === clave)!.hashEvidencia;
    expect(h(a, "banco")).not.toBe(h(b, "banco"));
    expect(h(a, "nomina")).toBe(h(b, "nomina"));
    expect(h(a, "sat")).toBe(h(b, "sat"));
  });

  it("los hechos sólo llevan señales (clave, estado, resumen)", () => {
    const banco = estadoDe(hechos(), "banco");
    expect(Object.keys(banco.hechos)).toEqual(["senales"]);
    const senales = banco.hechos.senales as Array<Record<string, unknown>>;
    expect(senales.map((s) => s.clave)).toEqual([
      "ce:banco",
      "ce:sin_clasificar",
      "fx:conciliacion-bancaria",
      "x:cuentas_sin_estado",
      "x:firmas_conciliacion",
    ]);
  });
});

describe("periodosEnJuego", () => {
  it("mes anterior + mes en curso, más cierres viejos abiertos, máximo 3", () => {
    expect(periodosEnJuego(new Date("2026-09-05T12:00:00"), [])).toEqual([
      { year: 2026, month: 8 },
      { year: 2026, month: 9 },
    ]);
    expect(periodosEnJuego(new Date("2026-01-10T12:00:00"), [])).toEqual([
      { year: 2025, month: 12 },
      { year: 2026, month: 1 },
    ]);
    expect(
      periodosEnJuego(new Date("2026-09-05T12:00:00"), [
        { year: 2026, month: 5 },
        { year: 2026, month: 7 },
        { year: 2026, month: 9 },
      ])
    ).toEqual([
      { year: 2026, month: 7 },
      { year: 2026, month: 8 },
      { year: 2026, month: 9 },
    ]);
  });
});
