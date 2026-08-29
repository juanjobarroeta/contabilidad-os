import { describe, it, expect } from "vitest";
import {
  decidirChecklist,
  fechaLimiteDeclaracion,
  diasParaFechaLimite,
  type ChecklistInputs,
  type ChecklistItem,
} from "./checklist-declaracion";

// ─────────────────────────────────────────────────────────────────────────────
// Golden tests de la LÓGICA DE DECISIÓN del checklist (función pura, sin DB) y
// de la matemática de la fecha límite (día 17 del mes siguiente, hábil, con
// cruce de ejercicio diciembre → enero).
// ─────────────────────────────────────────────────────────────────────────────

/** Empresa "limpia": todo sincronizado, conciliado, complementado y con nómina timbrada. */
function baseInputs(overrides: Partial<ChecklistInputs> = {}): ChecklistInputs {
  return {
    year: 2026,
    month: 5,
    hoy: new Date(2026, 5, 10), // 10 de junio de 2026 — antes del vencimiento (17 jun)
    fechaLimite: fechaLimiteDeclaracion(2026, 5),
    aperturaConfirmada: true,
    satEmitidosCompleto: true,
    satRecibidosCompleto: true,
    advertenciasCadena: [],
    movimientosSinConciliar: 0,
    repPorEmitir: { total: 0, vencidos: 0, montoPendiente: 0 },
    repProveedores: { total: 0, vencidos: 0 },
    iva: { pagar: 12500.5, saldoAFavor: 0 },
    isrPagar: 8300,
    diot: { aplica: true, generada: true, presentada: true },
    nomina: { tieneEmpleados: true, corridasDelMes: 2, timbradasDelMes: 2 },
    // mayo NO cierra bimestre → sin bloque bimestral en la base.
    imss: { aplica: true, estimadoMensual: 15200.4, pagadaMensual: true, bimestre: null },
    declaracionGuardada: true,
    declaracionPresentada: true,
    ...overrides,
  };
}

function item(items: ChecklistItem[], clave: string): ChecklistItem {
  const it = items.find((x) => x.clave === clave);
  if (!it) throw new Error(`Falta el item ${clave}`);
  return it;
}

describe("decidirChecklist — empresa limpia", () => {
  it("todo listo cuando datos completos, conciliado, complementado y presentada", () => {
    const items = decidirChecklist(baseInputs());
    expect(items.length).toBe(12);
    for (const it of items) {
      expect(it.estado, `item ${it.clave}`).toBe("listo");
    }
  });

  it("mantiene el orden de trabajo esperado", () => {
    const claves = decidirChecklist(baseInputs()).map((i) => i.clave);
    expect(claves).toEqual([
      "apertura",
      "sincronizacion-sat",
      "cadena-declaraciones",
      "conciliacion-bancaria",
      "complementos-por-emitir",
      "complementos-proveedores",
      "posicion-calculada",
      "diot",
      "nomina",
      "cuotas-imss",
      "declaracion-periodo",
      "fecha-limite",
    ]);
  });
});

describe("decidirChecklist — apertura fiscal", () => {
  it("apertura sin confirmar → atención, primero en la lista, con link a /empresa/apertura", () => {
    const items = decidirChecklist(baseInputs({ aperturaConfirmada: false }));
    const ap = item(items, "apertura");
    expect(items[0].clave).toBe("apertura");
    expect(ap.estado).toBe("atencion");
    expect(ap.detalle).toContain("no está confirmado");
    expect(ap.accionUrl).toBe("/empresa/apertura");
  });

  it("apertura confirmada → listo", () => {
    const ap = item(decidirChecklist(baseInputs({ aperturaConfirmada: true })), "apertura");
    expect(ap.estado).toBe("listo");
    expect(ap.detalle).toContain("confirmado");
  });
});

describe("decidirChecklist — sincronización SAT", () => {
  it("periodos faltantes → atención, nombrando la dirección que falta", () => {
    const items = decidirChecklist(baseInputs({ satRecibidosCompleto: false }));
    const sat = item(items, "sincronizacion-sat");
    expect(sat.estado).toBe("atencion");
    expect(sat.detalle).toContain("recibidos");
    expect(sat.detalle).not.toContain("emitidos y recibidos");
  });

  it("faltan ambas direcciones → atención con ambas", () => {
    const sat = item(
      decidirChecklist(baseInputs({ satEmitidosCompleto: false, satRecibidosCompleto: false })),
      "sincronizacion-sat"
    );
    expect(sat.estado).toBe("atencion");
    expect(sat.detalle).toContain("emitidos y recibidos");
  });
});

describe("decidirChecklist — cadena de declaraciones", () => {
  it("advertencias del motor → atención con SÓLO la primera oración (el texto completo vive en la alerta del Resumen)", () => {
    const aviso =
      "El mes anterior (abril de 2026) tiene CFDI timbrados pero no cuenta con una declaración guardada. " +
      "El saldo a favor se está tomando como cero, capture antes de confiar en estas cifras.";
    const cad = item(decidirChecklist(baseInputs({ advertenciasCadena: [aviso] })), "cadena-declaraciones");
    expect(cad.estado).toBe("atencion");
    expect(cad.detalle).toBe("El mes anterior (abril de 2026) tiene CFDI timbrados pero no cuenta con una declaración guardada.");
    expect(cad.accionUrl).toBe("/impuestos?tab=historial");
  });
});

describe("decidirChecklist — conciliación bancaria", () => {
  it("movimientos sin conciliar → pendiente con el conteo y link a /bancos", () => {
    const con = item(decidirChecklist(baseInputs({ movimientosSinConciliar: 7 })), "conciliacion-bancaria");
    expect(con.estado).toBe("pendiente");
    expect(con.detalle).toContain("7 movimiento(s)");
    expect(con.accionUrl).toBe("/bancos");
  });
});

describe("decidirChecklist — complementos de pago", () => {
  it("REP por emitir sin vencidos → pendiente con monto", () => {
    const rep = item(
      decidirChecklist(baseInputs({ repPorEmitir: { total: 3, vencidos: 0, montoPendiente: 45000 } })),
      "complementos-por-emitir"
    );
    expect(rep.estado).toBe("pendiente");
    expect(rep.detalle).toContain("3 cobro(s)");
    expect(rep.detalle).toContain("45,000");
  });

  it("REP por emitir con vencidos → atención", () => {
    const rep = item(
      decidirChecklist(baseInputs({ repPorEmitir: { total: 2, vencidos: 1, montoPendiente: 100 } })),
      "complementos-por-emitir"
    );
    expect(rep.estado).toBe("atencion");
    expect(rep.detalle).toContain("1 ya vencido(s)");
  });

  it("REP de proveedores pendientes → riesgo de deducción", () => {
    const rep = item(
      decidirChecklist(baseInputs({ repProveedores: { total: 4, vencidos: 2 } })),
      "complementos-proveedores"
    );
    expect(rep.estado).toBe("atencion");
    expect(rep.detalle).toContain("4 gasto(s)");
    expect(rep.detalle).toContain("deducción");
  });
});

describe("decidirChecklist — posición calculada", () => {
  it("con IVA e ISR determinados → listo con montos", () => {
    const pos = item(decidirChecklist(baseInputs()), "posicion-calculada");
    expect(pos.estado).toBe("listo");
    expect(pos.detalle).toContain("12,500.50");
    expect(pos.detalle).toContain("8,300");
  });

  it("saldo a favor de IVA → lo reporta como a favor", () => {
    const pos = item(
      decidirChecklist(baseInputs({ iva: { pagar: 0, saldoAFavor: 3200 } })),
      "posicion-calculada"
    );
    expect(pos.detalle).toContain("saldo a favor");
    expect(pos.detalle).toContain("3,200");
  });

  it("ISR indeterminable (sin coeficiente) → atención", () => {
    const pos = item(decidirChecklist(baseInputs({ isrPagar: null })), "posicion-calculada");
    expect(pos.estado).toBe("atencion");
    expect(pos.detalle).toContain("coeficiente");
  });
});

describe("decidirChecklist — DIOT", () => {
  it("sin obligación DIOT → no-aplica", () => {
    const diot = item(
      decidirChecklist(baseInputs({ diot: { aplica: false, generada: false, presentada: false } })),
      "diot"
    );
    expect(diot.estado).toBe("no-aplica");
    expect(diot.accionUrl).toBeUndefined();
  });

  it("generada pero no presentada → pendiente (falta presentarla)", () => {
    const diot = item(
      decidirChecklist(baseInputs({ diot: { aplica: true, generada: true, presentada: false } })),
      "diot"
    );
    expect(diot.estado).toBe("pendiente");
    expect(diot.detalle).toContain("generada");
  });

  it("ni generada → pendiente (generar y presentar)", () => {
    const diot = item(
      decidirChecklist(baseInputs({ diot: { aplica: true, generada: false, presentada: false } })),
      "diot"
    );
    expect(diot.estado).toBe("pendiente");
    expect(diot.detalle).toContain("genera");
  });
});

describe("decidirChecklist — nómina", () => {
  it("empresa sin empleados → no-aplica", () => {
    const nom = item(
      decidirChecklist(baseInputs({ nomina: { tieneEmpleados: false, corridasDelMes: 0, timbradasDelMes: 0 } })),
      "nomina"
    );
    expect(nom.estado).toBe("no-aplica");
    expect(nom.accionUrl).toBeUndefined();
  });

  it("con empleados y sin corridas del mes → pendiente", () => {
    const nom = item(
      decidirChecklist(baseInputs({ nomina: { tieneEmpleados: true, corridasDelMes: 0, timbradasDelMes: 0 } })),
      "nomina"
    );
    expect(nom.estado).toBe("pendiente");
  });

  it("corridas sin timbrar → pendiente con el conteo faltante", () => {
    const nom = item(
      decidirChecklist(baseInputs({ nomina: { tieneEmpleados: true, corridasDelMes: 3, timbradasDelMes: 1 } })),
      "nomina"
    );
    expect(nom.estado).toBe("pendiente");
    expect(nom.detalle).toContain("2 de 3");
  });
});

describe("decidirChecklist — cuotas IMSS (SIPARE)", () => {
  it("sin empleados ni nómina → no-aplica, sin link", () => {
    const im = item(
      decidirChecklist(
        baseInputs({ imss: { aplica: false, estimadoMensual: 0, pagadaMensual: false, bimestre: null } })
      ),
      "cuotas-imss"
    );
    expect(im.estado).toBe("no-aplica");
    expect(im.detalle).toContain("no hay cuotas IMSS");
    expect(im.accionUrl).toBeUndefined();
  });

  it("nómina timbrada sin pago registrado y antes del 17 → pendiente con estimado y fecha", () => {
    const im = item(
      decidirChecklist(
        baseInputs({ imss: { aplica: true, estimadoMensual: 15200.4, pagadaMensual: false, bimestre: null } })
      ),
      "cuotas-imss"
    );
    expect(im.estado).toBe("pendiente");
    expect(im.detalle).toContain("15,200.40");
    expect(im.detalle).toContain("estimado desde tu nómina timbrada");
    expect(im.detalle).toContain("17 de junio de 2026");
    expect(im.detalle).toContain("SIPARE");
    expect(im.accionUrl).toBe("/nomina");
  });

  it("sin pago y ya vencida → escala a atención con recargos", () => {
    const im = item(
      decidirChecklist(
        baseInputs({
          hoy: new Date(2026, 5, 20), // 20 jun > 17 jun
          imss: { aplica: true, estimadoMensual: 9000, pagadaMensual: false, bimestre: null },
        })
      ),
      "cuotas-imss"
    );
    expect(im.estado).toBe("atencion");
    expect(im.detalle).toContain("ya venció");
    expect(im.detalle).toContain("recargos");
  });

  it("pago mensual registrado (PAID) → listo", () => {
    const im = item(decidirChecklist(baseInputs()), "cuotas-imss");
    expect(im.estado).toBe("listo");
    expect(im.detalle).toContain("pagadas");
  });

  it("mes de cierre de bimestre: mensual pagada pero bimestral pendiente → sigue pendiente con RCV e Infonavit", () => {
    const im = item(
      decidirChecklist(
        baseInputs({
          month: 6,
          fechaLimite: fechaLimiteDeclaracion(2026, 6),
          hoy: new Date(2026, 6, 10),
          imss: {
            aplica: true,
            estimadoMensual: 15200.4,
            pagadaMensual: true,
            bimestre: { etiqueta: "mayo-junio de 2026", estimado: 4300, pagada: false },
          },
        })
      ),
      "cuotas-imss"
    );
    expect(im.estado).toBe("pendiente");
    expect(im.detalle).toContain("mensuales ya están pagadas");
    expect(im.detalle).toContain("mayo-junio de 2026");
    expect(im.detalle).toContain("RCV e Infonavit");
    expect(im.detalle).toContain("4,300");
  });

  it("mes de cierre con mensual y bimestral pagadas → listo mencionando el bimestre", () => {
    const im = item(
      decidirChecklist(
        baseInputs({
          month: 6,
          fechaLimite: fechaLimiteDeclaracion(2026, 6),
          hoy: new Date(2026, 6, 10),
          imss: {
            aplica: true,
            estimadoMensual: 15200.4,
            pagadaMensual: true,
            bimestre: { etiqueta: "mayo-junio de 2026", estimado: 4300, pagada: true },
          },
        })
      ),
      "cuotas-imss"
    );
    expect(im.estado).toBe("listo");
    expect(im.detalle).toContain("mayo-junio de 2026");
    expect(im.detalle).toContain("ya está pagado");
  });
});

describe("decidirChecklist — ajuste anual de ISR de sueldos (Art. 97 LISR)", () => {
  // Diciembre es el mes donde se practica el ajuste (la diferencia a favor se
  // compensa contra la retención de diciembre; la a cargo se retiene ahí y se
  // entera a más tardar en febrero). En v1 el punto es INFORMATIVO: sin
  // persistencia de "ajuste aplicado" siempre aparece pendiente con la liga.
  const diciembre = (overrides: Partial<ChecklistInputs> = {}) =>
    baseInputs({
      month: 12,
      fechaLimite: fechaLimiteDeclaracion(2026, 12),
      hoy: new Date(2027, 0, 5),
      ...overrides,
    });

  it("sólo aparece en diciembre", () => {
    const claves = decidirChecklist(baseInputs()).map((i) => i.clave); // mayo
    expect(claves).not.toContain("ajuste-anual");
    const clavesDic = decidirChecklist(diciembre()).map((i) => i.clave);
    expect(clavesDic).toContain("ajuste-anual");
  });

  it("con empleados → pendiente (informativo) con liga al reporte del ejercicio", () => {
    const it12 = item(decidirChecklist(diciembre()), "ajuste-anual");
    expect(it12.estado).toBe("pendiente");
    expect(it12.detalle).toContain("Art. 97");
    expect(it12.detalle).toContain("febrero");
    expect(it12.accionUrl).toBe("/nomina/ajuste-anual?ejercicio=2026");
  });

  it("sin empleados ni corridas en el mes → no aplica", () => {
    const it12 = item(
      decidirChecklist(
        diciembre({ nomina: { tieneEmpleados: false, corridasDelMes: 0, timbradasDelMes: 0 } })
      ),
      "ajuste-anual"
    );
    expect(it12.estado).toBe("no-aplica");
  });
});

describe("decidirChecklist — fecha límite y declaración", () => {
  it("no presentada y antes del vencimiento → pendiente con días restantes", () => {
    const inputs = baseInputs({ declaracionPresentada: false, declaracionGuardada: false });
    const items = decidirChecklist(inputs);
    const fl = item(items, "fecha-limite");
    // 10 jun → 17 jun 2026 (miércoles hábil): quedan 7 días.
    expect(fl.estado).toBe("pendiente");
    expect(fl.detalle).toContain("7 día(s)");
    expect(item(items, "declaracion-periodo").estado).toBe("pendiente");
  });

  it("guardada pero no presentada → pendiente indicando que falta el acuse", () => {
    const dec = item(
      decidirChecklist(baseInputs({ declaracionPresentada: false, declaracionGuardada: true })),
      "declaracion-periodo"
    );
    expect(dec.estado).toBe("pendiente");
    expect(dec.detalle).toContain("guardada");
  });

  it("vencida y no presentada → atención con días de atraso", () => {
    const fl = item(
      decidirChecklist(
        baseInputs({ declaracionPresentada: false, hoy: new Date(2026, 5, 20) }) // 20 jun > 17 jun
      ),
      "fecha-limite"
    );
    expect(fl.estado).toBe("atencion");
    expect(fl.detalle).toContain("venció hace 3 día(s)");
  });

  it("presentada → fecha límite en listo aunque el día ya pasó", () => {
    const fl = item(
      decidirChecklist(baseInputs({ hoy: new Date(2026, 6, 1) })),
      "fecha-limite"
    );
    expect(fl.estado).toBe("listo");
  });
});

describe("fechaLimiteDeclaracion — día 17 del mes siguiente, hábil", () => {
  it("mayo 2026 vence el 17 de junio de 2026 (miércoles hábil)", () => {
    const f = fechaLimiteDeclaracion(2026, 5);
    expect(f.getFullYear()).toBe(2026);
    expect(f.getMonth()).toBe(5); // junio
    expect(f.getDate()).toBe(17);
  });

  it("diciembre 2025 cruza el ejercicio: 17 ene 2026 es sábado → lunes 19", () => {
    const f = fechaLimiteDeclaracion(2025, 12);
    expect(f.getFullYear()).toBe(2026);
    expect(f.getMonth()).toBe(0); // enero
    expect(f.getDate()).toBe(19); // 17 cae sábado, recorre al lunes hábil
  });

  it("enero vence el 17 de febrero del mismo año", () => {
    const f = fechaLimiteDeclaracion(2026, 1);
    expect(f.getFullYear()).toBe(2026);
    expect(f.getMonth()).toBe(1); // febrero
    expect(f.getDate()).toBe(17); // 17 feb 2026 es martes hábil
  });
});

describe("diasParaFechaLimite", () => {
  it("mismo día → 0 (vence hoy, no vencida)", () => {
    expect(diasParaFechaLimite(new Date(2026, 5, 17), new Date(2026, 5, 17, 23, 30))).toBe(0);
  });

  it("días positivos antes y negativos después, ignorando la hora", () => {
    expect(diasParaFechaLimite(new Date(2026, 5, 17), new Date(2026, 5, 10, 1))).toBe(7);
    expect(diasParaFechaLimite(new Date(2026, 5, 17), new Date(2026, 5, 20, 23))).toBe(-3);
  });

  it("cruce de ejercicio: del 30 dic 2025 al 19 ene 2026 hay 20 días", () => {
    expect(diasParaFechaLimite(fechaLimiteDeclaracion(2025, 12), new Date(2025, 11, 30))).toBe(20);
  });
});
