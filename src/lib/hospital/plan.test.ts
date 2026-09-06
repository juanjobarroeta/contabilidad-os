import { describe, it, expect } from "vitest";
import {
  DESVIACION_ALERTA_PCT,
  compararPlan,
  descripcionHonorario,
  desviacionPct,
  errorPlanInmutable,
  errorTransicionPlan,
  faltaAutorizacion,
  honorariosDefault,
  honorariosDePlan,
  normalizarDescripcion,
  partidasDePlan,
  partidasParaCotizacion,
  totalesPlan,
  type CargoComparable,
  type PlanHonorario,
  type PlanInsumo,
  type PlanPartida,
} from "./plan";

const partida = (p: Partial<PlanPartida> & { importe: number; categoria: PlanPartida["categoria"]; descripcion: string }): PlanPartida => ({
  orden: 0,
  servicioId: null,
  cantidad: 1,
  precioUnitario: p.importe,
  ivaTasa: 0.16,
  opcional: false,
  ...p,
});

describe("totalesPlan", () => {
  it("suma partidas con su IVA por renglón y los honorarios exentos en el subtotal (como la cuenta)", () => {
    const t = totalesPlan(
      [
        partida({ categoria: "HABITACION", descripcion: "Habitación", importe: 6400, ivaTasa: 0.16 }),
        partida({ categoria: "FARMACIA", descripcion: "Medicamentos", importe: 1000, ivaTasa: 0 }),
        partida({ categoria: "PROCEDIMIENTO", descripcion: "Curación", importe: 500, ivaTasa: null }),
      ],
      [{ medicoId: "m1", nombre: "Dr. Vega", rol: "CIRUJANO", monto: 25000 }]
    );
    expect(t).toEqual({ subtotal: 32900, iva: 1024, total: 33924, honorarios: 25000 });
  });
});

describe("reglas de estado", () => {
  it("transiciones: PROPUESTO ↔ AUTORIZADO, todo vivo se cancela, CERRADO y CANCELADO no se mueven", () => {
    expect(errorTransicionPlan("PROPUESTO", "AUTORIZADO")).toBeNull();
    expect(errorTransicionPlan("AUTORIZADO", "PROPUESTO")).toBeNull();
    expect(errorTransicionPlan("EN_CURSO", "CANCELADO")).toBeNull();
    expect(errorTransicionPlan("PROPUESTO", "PROPUESTO")).toBeNull();
    expect(errorTransicionPlan("PROPUESTO", "CERRADO")).toMatch(/De PROPUESTO no se pasa a CERRADO/);
    expect(errorTransicionPlan("EN_CURSO", "AUTORIZADO")).toMatch(/permitido: CANCELADO/);
    expect(errorTransicionPlan("CERRADO", "CANCELADO")).toMatch(/ninguno/);
  });

  it("CERRADO y CANCELADO son inmutables", () => {
    expect(errorPlanInmutable("CERRADO")).toMatch(/cerrado/);
    expect(errorPlanInmutable("CANCELADO")).toMatch(/cancelado/);
    expect(errorPlanInmutable("EN_CURSO")).toBeNull();
    expect(errorPlanInmutable("PROPUESTO")).toBeNull();
  });

  it("AUTORIZADO exige número de autorización sólo con aseguradora o empresa", () => {
    expect(faltaAutorizacion("ASEGURADORA", null)).toBe(true);
    expect(faltaAutorizacion("EMPRESA", "  ")).toBe(true);
    expect(faltaAutorizacion("ASEGURADORA", "GNP-4471")).toBe(false);
    expect(faltaAutorizacion("PARTICULAR", null)).toBe(false);
    expect(faltaAutorizacion("GOBIERNO", null)).toBe(false);
    expect(faltaAutorizacion(null, null)).toBe(false);
  });
});

describe("honorarios", () => {
  it("del protocolo sólo para los médicos que ya se asignaron", () => {
    const protocolo = { honorarioCirujano: 25000, honorarioAnestesiologo: 8000 };
    expect(honorariosDefault({ protocolo, medico: { id: "m1", nombre: "Dr. Vega" }, anestesiologo: null })).toEqual([
      { medicoId: "m1", nombre: "Dr. Vega", rol: "CIRUJANO", monto: 25000 },
    ]);
    expect(honorariosDefault({ protocolo, medico: { id: "m1", nombre: "Dr. Vega" }, anestesiologo: { id: "m2", nombre: "Dra. Ruiz" } })).toHaveLength(2);
    expect(honorariosDefault({ protocolo: null, medico: { id: "m1", nombre: "Dr. Vega" }, anestesiologo: null })).toEqual([]);
    expect(honorariosDefault({ protocolo: { honorarioCirujano: null, honorarioAnestesiologo: null }, medico: { id: "m1", nombre: "Dr. Vega" }, anestesiologo: null })).toEqual([]);
  });

  it("viajan a la cotización como renglones HONORARIO exentos; las partidas opcionales se marcan", () => {
    const rows = partidasParaCotizacion(
      [
        partida({ servicioId: "s1", categoria: "HABITACION", descripcion: "Habitación", importe: 3200 }),
        partida({ categoria: "ESTUDIO", descripcion: "Colangiografía", importe: 900, opcional: true }),
      ],
      [{ medicoId: "m1", nombre: "Dr. Vega", rol: "CIRUJANO", monto: 25000 }]
    );
    expect(rows).toHaveLength(3);
    expect(rows[1].descripcion).toBe("Colangiografía (opcional)");
    expect(rows[2]).toMatchObject({ orden: 2, categoria: "HONORARIO", descripcion: "Honorarios cirujano · Dr. Vega", cantidad: 1, precioUnitario: 25000, ivaTasa: null, importe: 25000 });
    expect(descripcionHonorario({ rol: "ANESTESIOLOGO", nombre: "Dra. Ruiz" })).toBe("Honorarios anestesiólogo · Dra. Ruiz");
  });
});

describe("JSON del plan", () => {
  it("tolera JSON incompleto o ajeno", () => {
    expect(partidasDePlan(null)).toEqual([]);
    expect(partidasDePlan([{ descripcion: "x", categoria: "OTRO", importe: "12.5" }])[0]).toMatchObject({ orden: 0, cantidad: 1, importe: 12.5, ivaTasa: null, opcional: false });
    expect(honorariosDePlan([{ rol: "RARO", nombre: "n", monto: 5 }])[0]).toMatchObject({ rol: "CIRUJANO", monto: 5, medicoId: null });
  });

  it("normaliza descripciones sin acentos ni mayúsculas ni espacios dobles", () => {
    expect(normalizarDescripcion("  Habitación   Estándar · 13 ago ")).toBe("habitacion estandar · 13 ago");
  });
});

describe("desviacionPct", () => {
  it("porcentaje sobre el plan; null sin plan", () => {
    expect(desviacionPct(10000, 11800)).toBe(18);
    expect(desviacionPct(10000, 9000)).toBe(-10);
    expect(desviacionPct(0, 500)).toBeNull();
    expect(DESVIACION_ALERTA_PCT).toBe(15);
  });
});

describe("compararPlan (la cuenta contra lo planeado)", () => {
  const partidas: PlanPartida[] = [
    partida({ orden: 0, servicioId: "s-hab", categoria: "HABITACION", descripcion: "Habitación estándar", cantidad: 2, precioUnitario: 3200, importe: 6400 }),
    partida({ orden: 1, servicioId: "s-qx", categoria: "QUIROFANO", descripcion: "Quirófano", cantidad: 1.5, precioUnitario: 6000, importe: 9000 }),
    partida({ orden: 2, categoria: "MATERIAL", descripcion: "Kit de Laparoscopía", importe: 8000 }),
    partida({ orden: 3, servicioId: "s-lab", categoria: "ESTUDIO", descripcion: "Biometría hemática", importe: 380, opcional: true }),
  ];
  const honorarios: PlanHonorario[] = [
    { medicoId: "m1", nombre: "Dr. Vega", rol: "CIRUJANO", monto: 25000 },
    { medicoId: "m2", nombre: "Dra. Ruiz", rol: "ANESTESIOLOGO", monto: 8000 },
  ];
  const insumos: PlanInsumo[] = [
    { insumoId: "i-propofol", clave: "PROP", nombre: "Propofol", unidad: "ampolleta", cantidad: 2, costoUnitario: 85.5, opcional: false },
    { insumoId: "i-gasa", clave: "GASA", nombre: "Gasa", unidad: "pieza", cantidad: 10, costoUnitario: 2, opcional: true },
  ];
  // subtotal 23780 + honorarios 33000 = 56780; iva 16 % de 23780 = 3804.8 → total 60584.8
  const plan = { partidas, honorarios, insumos, subtotal: 56780, total: 60584.8 };

  const cargo = (c: Partial<CargoComparable> & { id: string; categoria: CargoComparable["categoria"]; descripcion: string; importe: number }): CargoComparable => ({
    fecha: "2026-09-03",
    cantidad: 1,
    ivaTasa: 0.16,
    servicioId: null,
    medicoId: null,
    origen: "MANUAL",
    ...c,
  });

  const cargos: CargoComparable[] = [
    // Estancia: dos noches, cada una un cargo con el servicio de la cama (la descripción trae fechas).
    cargo({ id: "c1", categoria: "HABITACION", descripcion: "Habitación estándar · 3 sep", importe: 3200, servicioId: "s-hab", origen: "ESTANCIA" }),
    cargo({ id: "c2", categoria: "HABITACION", descripcion: "Habitación estándar · 4 sep", importe: 3200, servicioId: "s-hab", origen: "ESTANCIA" }),
    cargo({ id: "c3", categoria: "HABITACION", descripcion: "Habitación estándar · 5 sep", importe: 3200, servicioId: "s-hab", origen: "ESTANCIA" }),
    // Quirófano: 2 h en vez de 1.5.
    cargo({ id: "c4", categoria: "QUIROFANO", descripcion: "Quirófano por hora", importe: 12000, cantidad: 2, servicioId: "s-qx", origen: "COTIZACION" }),
    // Material sin servicio: cuadra por categoría + descripción normalizada (acentos/mayúsculas distintas).
    cargo({ id: "c5", categoria: "MATERIAL", descripcion: "KIT DE LAPAROSCOPIA", importe: 8000, origen: "COTIZACION" }),
    // Honorario del cirujano por médico; el del anestesiólogo llegó de la cotización sin medicoId: cuadra por descripción.
    cargo({ id: "c6", categoria: "HONORARIO", descripcion: "Honorarios médicos", importe: 25000, ivaTasa: null, medicoId: "m1", origen: "EXPEDIENTE" }),
    cargo({ id: "c7", categoria: "HONORARIO", descripcion: "Honorarios anestesiólogo · Dra. Ruiz", importe: 8000, ivaTasa: null, origen: "COTIZACION" }),
    // Fuera de plan: farmacia y un estudio no planeado.
    cargo({ id: "c8", categoria: "FARMACIA", descripcion: "Propofol · lote P-1174 · 2 ampolleta", importe: 300, ivaTasa: 0.16, origen: "FARMACIA" }),
    cargo({ id: "c9", categoria: "ESTUDIO", descripcion: "Tomografía de abdomen", importe: 4500, origen: "MANUAL" }),
    // Cancelado: no cuenta.
    cargo({ id: "c10", categoria: "ESTUDIO", descripcion: "Tomografía de abdomen", importe: 4500, cancelado: true }),
  ];
  const movimientos = [
    { insumoId: "i-propofol", nombre: "Propofol", cantidad: -3, costoUnitario: 90 },
    { insumoId: "i-propofol", nombre: "Propofol", cantidad: 1, costoUnitario: 90 }, // devolución
    { insumoId: "i-sutura", nombre: "Sutura 3-0", cantidad: -2, costoUnitario: 40 },
  ];

  const r = compararPlan({ plan, cargos, movimientos });
  const fila = (descripcion: string) => r.partidas.find((f) => f.descripcion === descripcion)!;

  it("cuadra por servicio (varios cargos en una partida), por descripción normalizada y por médico", () => {
    expect(fila("Habitación estándar")).toMatchObject({ planCantidad: 2, planImporte: 6400, realCantidad: 3, realImporte: 9600, desviacion: 3200, cargos: ["c1", "c2", "c3"] });
    expect(fila("Quirófano")).toMatchObject({ realCantidad: 2, realImporte: 12000, desviacion: 3000 });
    expect(fila("Kit de Laparoscopía")).toMatchObject({ realImporte: 8000, desviacion: 0, cargos: ["c5"] });
    expect(fila("Honorarios cirujano · Dr. Vega")).toMatchObject({ tipo: "HONORARIO", medicoId: "m1", realImporte: 25000, cargos: ["c6"] });
    expect(fila("Honorarios anestesiólogo · Dra. Ruiz")).toMatchObject({ tipo: "HONORARIO", realImporte: 8000, cargos: ["c7"] });
  });

  it("la partida opcional sin cargo queda sin aplicar", () => {
    expect(fila("Biometría hemática")).toMatchObject({ opcional: true, realCantidad: 0, realImporte: 0, desviacion: -380 });
    expect(r.resumen.sinAplicar).toBe(380);
  });

  it("lo que no cuadra es fuera de plan y el cancelado no cuenta", () => {
    expect(r.fueraDePlan.map((c) => c.id)).toEqual(["c8", "c9"]);
    expect(r.fueraDePlan[0]).toMatchObject({ importe: 300, iva: 48, total: 348, origen: "FARMACIA" });
    expect(r.resumen.fueraDePlan).toBe(4800);
    expect(r.resumen.cargos).toBe(9);
  });

  it("resumen: totales con IVA y desviación en %", () => {
    // Real sin IVA: 9600 + 12000 + 8000 + 25000 + 8000 + 300 + 4500 = 67400
    // IVA: (9600 + 12000 + 8000 + 300 + 4500) × 0.16 = 5504
    expect(r.resumen).toMatchObject({ planSubtotal: 56780, planTotal: 60584.8, realSubtotal: 67400, realTotal: 72904, desviacion: 12319.2, desviacionPct: 20.33 });
    expect(r.resumen.desviacionPct!).toBeGreaterThan(DESVIACION_ALERTA_PCT);
  });

  it("por categoría suma partidas y fuera de plan", () => {
    const cat = (c: string) => r.porCategoria.find((x) => x.categoria === c)!;
    expect(cat("HABITACION")).toEqual({ categoria: "HABITACION", planImporte: 6400, realImporte: 9600, desviacion: 3200 });
    expect(cat("ESTUDIO")).toEqual({ categoria: "ESTUDIO", planImporte: 380, realImporte: 4500, desviacion: 4120 });
    expect(cat("FARMACIA")).toEqual({ categoria: "FARMACIA", planImporte: 0, realImporte: 300, desviacion: 300 });
    expect(cat("HONORARIO")).toEqual({ categoria: "HONORARIO", planImporte: 33000, realImporte: 33000, desviacion: 0 });
  });

  it("insumos: planeados contra aplicados con el signo del kardex (salida −, devolución +)", () => {
    expect(r.insumos.planeados[0]).toMatchObject({ insumoId: "i-propofol", cantidad: 2, costo: 171, aplicado: 2, costoAplicado: 180, desviacion: 0 });
    expect(r.insumos.planeados[1]).toMatchObject({ insumoId: "i-gasa", aplicado: 0, costoAplicado: 0, desviacion: -10 });
    expect(r.insumos.aplicados.map((a) => [a.insumoId, a.cantidad, a.costo, a.planeado])).toEqual([
      ["i-propofol", 2, 180, true],
      ["i-sutura", 2, 80, false],
    ]);
    expect(r.insumos.resumen).toEqual({ costoPlaneado: 191, costoAplicado: 260, noPlaneados: 1 });
  });

  it("sin cargos ni movimientos: todo sin aplicar, desviación negativa completa", () => {
    const vacio = compararPlan({ plan, cargos: [], movimientos: [] });
    expect(vacio.resumen).toMatchObject({ realTotal: 0, desviacion: -60584.8, desviacionPct: -100, sinAplicar: 56780, cargos: 0 });
    expect(vacio.fueraDePlan).toEqual([]);
    expect(vacio.insumos.aplicados).toEqual([]);
  });

  it("dos partidas del mismo servicio se funden en una fila", () => {
    const dup = compararPlan({
      plan: { partidas: [partidas[0], { ...partidas[0], orden: 9, cantidad: 1, importe: 3200 }], honorarios: [], insumos: [], subtotal: 9600, total: 11136 },
      cargos: [cargos[0]],
      movimientos: [],
    });
    expect(dup.partidas).toHaveLength(1);
    expect(dup.partidas[0]).toMatchObject({ planCantidad: 3, planImporte: 9600, realCantidad: 1, realImporte: 3200 });
  });
});
