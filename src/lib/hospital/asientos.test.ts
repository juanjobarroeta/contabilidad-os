import { describe, it, expect } from "vitest";
import {
  TIPO_ASIENTO,
  asentarDeposito,
  asentarHonorarios,
  asentarMes,
  asentarSalidaFarmacia,
  contextoAsientos,
  ejecutarPlan,
  esPersonaFisica,
  planSalidaFarmacia,
  planesDeposito,
  planesHonorarios,
  previewMes,
  retencionesPorMedico,
  type AsientoPlan,
} from "./asientos";
import { HospitalError } from "./errores";
import { DbFalsa, comoDb } from "./__fixtures__/db-falsa";

const F = (iso: string) => new Date(iso);

function conCatalogo(activa = true) {
  const db = new DbFalsa().sembrar(["101.01", "102.01", "105.01", "115.01", "501.01", "216.04"]);
  db.configRow = { contabilidadActiva: activa, cuentasContables: null };
  return db;
}

const movimiento = (over: Partial<Parameters<typeof planSalidaFarmacia>[0]> = {}) => ({
  id: "mov1",
  companyId: "c1",
  tipo: "SALIDA_APLICACION" as const,
  cantidad: -6,
  costoUnitario: 42.5,
  fecha: F("2026-09-02T14:20:00Z"),
  asientoAt: null,
  descripcion: "Cefalotina 1 g · lote L-2291",
  ...over,
});

describe("salida de farmacia", () => {
  it("plan: COSTO_FARMACIA / INVENTARIO_FARMACIA al costo del lote × cantidad", () => {
    const plan = planSalidaFarmacia(movimiento())!;
    expect(plan).toMatchObject({ monto: 255, cargo: "COSTO_FARMACIA", abono: "INVENTARIO_FARMACIA", referencia: "mov1", referenciaTipo: TIPO_ASIENTO.FARMACIA_SALIDA });
    expect(plan.descripcion).toContain("Cefalotina");
  });

  it("sin costo, o un tipo que no es aplicación al paciente → nada", () => {
    expect(planSalidaFarmacia(movimiento({ costoUnitario: 0 }))).toBeNull();
    expect(planSalidaFarmacia(movimiento({ costoUnitario: null }))).toBeNull();
    expect(planSalidaFarmacia(movimiento({ tipo: "MERMA" }))).toBeNull();
    expect(planSalidaFarmacia(movimiento({ tipo: "SALIDA_VENTA" }))).toBeNull();
  });

  it("asienta una vez, marca asientoAt y no repite", async () => {
    const db = conCatalogo();
    db.movimientos.push({ ...movimiento() });
    expect(await asentarSalidaFarmacia(comoDb(db), movimiento())).toBe(1);
    expect(db.pares()).toEqual([{ referencia: "mov1", referenciaTipo: "HOSP_FARMACIA_SALIDA", monto: 255, cargo: "501.01", abono: "115.01", year: 2026, month: 9 }]);
    expect(db.movimientos[0].asientoAt).toBeInstanceOf(Date);
    // Con asientoAt puesto no vuelve; y aunque llegara sin él, el libro ya lo tiene.
    expect(await asentarSalidaFarmacia(comoDb(db), { ...movimiento(), asientoAt: new Date() })).toBe(0);
    expect(await asentarSalidaFarmacia(comoDb(db), movimiento())).toBe(0);
    expect(db.asientos).toHaveLength(2);
  });

  it("contabilidad apagada → no-op, sin tocar cuentas", async () => {
    const db = conCatalogo(false);
    expect(await asentarSalidaFarmacia(comoDb(db), movimiento())).toBe(0);
    expect(db.asientos).toHaveLength(0);
    db.configRow = null;
    expect(await asentarSalidaFarmacia(comoDb(db), movimiento())).toBe(0);
  });

  it("ejercicio cerrado → 409 del módulo (no un 500)", async () => {
    const db = conCatalogo();
    db.periodos.push({ companyId: "c1", year: 2026, month: 9, status: "CLOSED" });
    await expect(asentarSalidaFarmacia(comoDb(db), movimiento())).rejects.toBeInstanceOf(HospitalError);
    await expect(asentarSalidaFarmacia(comoDb(db), movimiento())).rejects.toMatchObject({ status: 409 });
  });
});

describe("honorarios al alta", () => {
  const vega = { id: "m1", nombre: "Dr. Alonso Vega", rfc: "VEGA800101AB1" }; // PF
  const lab = { id: "m2", nombre: "Laboratorios SA", rfc: "LAB010101AB1" }; // PM
  const sinRfc = { id: "m3", nombre: "Dra. Rentería", rfc: null, supplier: { rfc: "RENC900101XY2" } };

  it("esPersonaFisica: 13 posiciones", () => {
    expect(esPersonaFisica("VEGA800101AB1")).toBe(true);
    expect(esPersonaFisica("LAB010101AB1")).toBe(false);
    expect(esPersonaFisica(null)).toBe(false);
  });

  it("retiene ISR 10 % sólo a PF con RFC (propio o de su proveedor); IVA 2/3 sólo si el honorario lleva IVA", () => {
    const ret = retencionesPorMedico(
      [
        { id: "k1", medicoId: "m1", importe: 18000, ivaTasa: null, medico: vega },
        { id: "k2", medicoId: "m1", importe: 2000, ivaTasa: 0.16, medico: vega },
        { id: "k3", medicoId: "m2", importe: 5000, ivaTasa: 0.16, medico: lab },
        { id: "k4", medicoId: "m3", importe: 8500, ivaTasa: null, medico: sinRfc },
        { id: "k5", medicoId: null, importe: 100, ivaTasa: null, medico: null },
      ],
      true
    );
    expect(ret).toEqual([
      { medicoId: "m1", nombre: "Dr. Alonso Vega", honorario: 20000, iva: 320, retencionIsr: 2000, retencionIva: 213.33, cargoIds: ["k1", "k2"] },
      { medicoId: "m3", nombre: "Dra. Rentería", honorario: 8500, iva: 0, retencionIsr: 850, retencionIva: 0, cargoIds: ["k4"] },
    ]);
  });

  it("el hospital persona física no retiene", () => {
    expect(retencionesPorMedico([{ id: "k1", medicoId: "m1", importe: 18000, ivaTasa: null, medico: vega }], false)).toEqual([]);
  });

  it("planes: cargo al pasivo del médico, abono a la retención, a la fecha del alta", () => {
    const planes = planesHonorarios({ id: "e1", folio: "HOSP-2026-0418", fechaAlta: F("2026-09-05T18:00:00Z") }, [
      { id: "k1", medicoId: "m1", importe: 18000, ivaTasa: null, medico: vega },
      { id: "k2", medicoId: "m1", importe: 2000, ivaTasa: 0.16, medico: vega },
    ], true);
    expect(planes.map((p) => [p.referenciaTipo, p.cargo, p.abono, p.monto, p.referencia])).toEqual([
      [TIPO_ASIENTO.HONORARIOS_RET_ISR, "HONORARIOS_POR_CUENTA_DE_TERCEROS", "RETENCION_ISR_HONORARIOS", 2000, "e1:m1"],
      [TIPO_ASIENTO.HONORARIOS_RET_IVA, "HONORARIOS_POR_CUENTA_DE_TERCEROS", "RETENCION_IVA_HONORARIOS", 213.33, "e1:m1"],
    ]);
    expect(planes[0].fecha.toISOString()).toBe("2026-09-05T18:00:00.000Z");
    expect(planes[0].descripcion).toContain("HOSP-2026-0418");
  });

  it("asentarHonorarios: por médico, crea 205.06/216.04 del catálogo, marca los cargos y es idempotente", async () => {
    const db = conCatalogo();
    db.medicos.push(vega, lab);
    db.episodios.push({ id: "e1", companyId: "c1", folio: "HOSP-1", estado: "ALTA", fechaAlta: F("2026-09-05T18:00:00Z") });
    db.cargos.push(
      { id: "k1", companyId: "c1", episodioId: "e1", categoria: "HONORARIO", medicoId: "m1", importe: 18000, ivaTasa: null, cancelado: false, asientoAt: null },
      { id: "k2", companyId: "c1", episodioId: "e1", categoria: "HONORARIO", medicoId: "m2", importe: 5000, ivaTasa: 0.16, cancelado: false, asientoAt: null },
      { id: "k3", companyId: "c1", episodioId: "e1", categoria: "HONORARIO", medicoId: "m1", importe: 999, ivaTasa: null, cancelado: true, asientoAt: null },
      { id: "k4", companyId: "c1", episodioId: "e1", categoria: "QUIROFANO", medicoId: "m1", importe: 12000, ivaTasa: 0.16, cancelado: false, asientoAt: null }
    );
    const ep = { id: "e1", companyId: "c1", folio: "HOSP-1", fechaAlta: F("2026-09-05T18:00:00Z") };
    expect(await asentarHonorarios(comoDb(db), ep)).toBe(1);
    expect(db.pares()).toEqual([{ referencia: "e1:m1", referenciaTipo: "HOSP_HONORARIOS_RET_ISR", monto: 1800, cargo: "205.06", abono: "216.04", year: 2026, month: 9 }]);
    expect(db.cargos.find((c) => c.id === "k1")!.asientoAt).toBeInstanceOf(Date);
    // La PM no se marca (no hay nada que retener) y el cancelado tampoco.
    expect(db.cargos.find((c) => c.id === "k2")!.asientoAt).toBeNull();
    expect(db.cargos.find((c) => c.id === "k3")!.asientoAt).toBeNull();
    expect(await asentarHonorarios(comoDb(db), ep)).toBe(0);
    expect(db.asientos).toHaveLength(2);
  });

  it("apagada → nada", async () => {
    const db = conCatalogo(false);
    db.medicos.push(vega);
    db.cargos.push({ id: "k1", companyId: "c1", episodioId: "e1", categoria: "HONORARIO", medicoId: "m1", importe: 18000, ivaTasa: null, cancelado: false, asientoAt: null });
    expect(await asentarHonorarios(comoDb(db), { id: "e1", companyId: "c1", folio: "HOSP-1", fechaAlta: new Date() })).toBe(0);
    expect(db.asientos).toHaveLength(0);
  });
});

describe("depósitos", () => {
  const dep = (over: Partial<Parameters<typeof planesDeposito>[0]> = {}) => ({
    id: "d1",
    companyId: "c1",
    fecha: F("2026-09-01T16:00:00Z"),
    monto: 5000,
    formaPago: "EFECTIVO" as const,
    estado: "RECIBIDO" as const,
    folio: "HOSP-1",
    ...over,
  });

  it("RECIBIDO: efectivo a CAJA, lo demás a FONDOS_EN_TRANSITO, contra ANTICIPOS_PACIENTES", () => {
    expect(planesDeposito(dep())).toMatchObject([{ referenciaTipo: TIPO_ASIENTO.DEPOSITO_RECIBIDO, cargo: "CAJA", abono: "ANTICIPOS_PACIENTES", monto: 5000 }]);
    expect(planesDeposito(dep({ formaPago: "TARJETA" }))[0].cargo).toBe("FONDOS_EN_TRANSITO");
    expect(planesDeposito(dep({ formaPago: "TRANSFERENCIA" }))[0].cargo).toBe("FONDOS_EN_TRANSITO");
    expect(planesDeposito(dep({ formaPago: "CHEQUE" }))[0].cargo).toBe("FONDOS_EN_TRANSITO");
  });

  it("APLICADO / DEVUELTO traen el recibido y su etapa, cada una con su fecha", () => {
    const aplicado = planesDeposito(dep({ estado: "APLICADO", aplicadoAt: F("2026-10-03T12:00:00Z") }));
    expect(aplicado.map((p) => [p.referenciaTipo, p.cargo, p.abono, p.fecha.toISOString()])).toEqual([
      [TIPO_ASIENTO.DEPOSITO_RECIBIDO, "CAJA", "ANTICIPOS_PACIENTES", "2026-09-01T16:00:00.000Z"],
      [TIPO_ASIENTO.DEPOSITO_APLICADO, "ANTICIPOS_PACIENTES", "CLIENTES", "2026-10-03T12:00:00.000Z"],
    ]);
    const devuelto = planesDeposito(dep({ estado: "DEVUELTO", devueltoAt: F("2026-09-06T12:00:00Z"), formaPago: "CHEQUE" }));
    expect(devuelto[1]).toMatchObject({ referenciaTipo: TIPO_ASIENTO.DEPOSITO_DEVUELTO, cargo: "ANTICIPOS_PACIENTES", abono: "FONDOS_EN_TRANSITO" });
  });

  it("con rango sólo las etapas del mes; CANCELADO sólo se reversa cuando se pide", () => {
    const rango = { desde: F("2026-10-01T00:00:00Z"), hasta: F("2026-11-01T00:00:00Z") };
    const planes = planesDeposito(dep({ estado: "APLICADO", aplicadoAt: F("2026-10-03T12:00:00Z") }), { rango });
    expect(planes.map((p) => p.referenciaTipo)).toEqual([TIPO_ASIENTO.DEPOSITO_APLICADO]);
    expect(planesDeposito(dep({ estado: "CANCELADO" }))).toEqual([]);
    const ahora = F("2026-09-02T10:00:00Z");
    expect(planesDeposito(dep({ estado: "CANCELADO" }), { reversarCancelado: true, ahora })).toMatchObject([
      { referenciaTipo: TIPO_ASIENTO.DEPOSITO_CANCELADO, cargo: "ANTICIPOS_PACIENTES", abono: "CAJA", fecha: ahora },
    ]);
  });

  it("asentarDeposito en el ciclo completo: recibido → aplicado, sin repetir el recibido", async () => {
    const db = conCatalogo();
    db.depositos.push({ ...dep(), aplicadoAt: null, devueltoAt: null, asientoAt: null });
    expect(await asentarDeposito(comoDb(db), dep())).toBe(1);
    expect(db.pares()).toMatchObject([{ referenciaTipo: "HOSP_DEPOSITO_RECIBIDO", cargo: "101.01", abono: "206.01", monto: 5000 }]);
    expect(db.depositos[0].asientoAt).toBeInstanceOf(Date);

    const aplicado = dep({ estado: "APLICADO", aplicadoAt: F("2026-09-06T12:00:00Z") });
    expect(await asentarDeposito(comoDb(db), aplicado)).toBe(1);
    expect(db.pares().map((p) => p.referenciaTipo)).toEqual(["HOSP_DEPOSITO_RECIBIDO", "HOSP_DEPOSITO_APLICADO"]);
    expect(db.pares()[1]).toMatchObject({ cargo: "206.01", abono: "105.01" });
    expect(await asentarDeposito(comoDb(db), aplicado)).toBe(0);
  });

  it("cancelar reversa el recibido sólo si ya estaba en el libro", async () => {
    const db = conCatalogo();
    db.depositos.push({ ...dep(), asientoAt: null });
    // Nunca se asentó (p. ej. contabilidad apagada al recibir) → cancelar no escribe.
    expect(await asentarDeposito(comoDb(db), dep({ estado: "CANCELADO" }))).toBe(0);
    // Se asentó y luego se cancela → reversa.
    expect(await asentarDeposito(comoDb(db), dep())).toBe(1);
    expect(await asentarDeposito(comoDb(db), dep({ estado: "CANCELADO" }), { ahora: F("2026-09-02T10:00:00Z") })).toBe(1);
    expect(db.pares()[1]).toMatchObject({ referenciaTipo: "HOSP_DEPOSITO_CANCELADO", cargo: "206.01", abono: "101.01", monto: 5000 });
  });

  it("apagada → nada", async () => {
    const db = conCatalogo(false);
    expect(await asentarDeposito(comoDb(db), dep())).toBe(0);
    expect(db.asientos).toHaveLength(0);
  });
});

describe("ejecutarPlan()", () => {
  it("cargo y abono en la misma cuenta → 409 (mapa mal configurado)", async () => {
    const db = conCatalogo();
    const ctx = await contextoAsientos(comoDb(db), "c1");
    const plan: AsientoPlan = {
      fecha: F("2026-09-02T00:00:00Z"),
      descripcion: "x",
      monto: 10,
      referencia: "r",
      referenciaTipo: "T",
      cargo: "CAJA",
      abono: "CAJA",
      marcar: async () => undefined,
    };
    await expect(ejecutarPlan(comoDb(db), ctx, plan)).rejects.toMatchObject({ status: 409 });
  });
});

describe("mes: previewMes() y asentarMes()", () => {
  function armarMes(activa: boolean) {
    const db = conCatalogo(activa);
    db.medicos.push({ id: "m1", nombre: "Dr. Vega", rfc: "VEGA800101AB1" });
    db.insumos.push({ id: "i1", nombre: "Cefalotina 1 g" });
    db.lotes.push({ id: "l1", lote: "L-2291" });
    db.episodios.push({ id: "e1", companyId: "c1", folio: "HOSP-1", estado: "ALTA", fechaAlta: F("2026-09-05T18:00:00Z") });
    db.movimientos.push(
      { id: "mv1", companyId: "c1", insumoId: "i1", loteId: "l1", tipo: "SALIDA_APLICACION", cantidad: -2, costoUnitario: 100, fecha: F("2026-09-02T10:00:00Z"), asientoAt: null },
      { id: "mv-agosto", companyId: "c1", insumoId: "i1", loteId: "l1", tipo: "SALIDA_APLICACION", cantidad: -2, costoUnitario: 100, fecha: F("2026-08-30T10:00:00Z"), asientoAt: null }
    );
    db.cargos.push({ id: "k1", companyId: "c1", episodioId: "e1", categoria: "HONORARIO", medicoId: "m1", importe: 10000, ivaTasa: null, cancelado: false, asientoAt: null });
    db.depositos.push({ id: "d1", companyId: "c1", episodioId: "e1", fecha: F("2026-09-01T16:00:00Z"), monto: 3000, formaPago: "TRANSFERENCIA", estado: "APLICADO", aplicadoAt: F("2026-10-02T12:00:00Z"), devueltoAt: null, asientoAt: null });
    return db;
  }

  it("preview: lo pendiente del mes (sin crear cuentas), luego asentar lo deja en el libro y el preview lo enseña asentado", async () => {
    const db = armarMes(true);
    const antes = await previewMes(comoDb(db), "c1", 2026, 9);
    expect(antes.activa).toBe(true);
    expect(antes.asientos.map((a) => [a.referenciaTipo, a.monto, a.asentado, a.cargo.codigo, a.abono.codigo])).toEqual([
      ["HOSP_DEPOSITO_RECIBIDO", 3000, false, "107.05", "206.01"],
      ["HOSP_FARMACIA_SALIDA", 200, false, "501.01", "115.01"],
      ["HOSP_HONORARIOS_RET_ISR", 1000, false, "205.06", "216.04"],
    ]);
    expect(db.cuentaPorCodigo("206.01")).toBeNull();

    const r = await asentarMes(comoDb(db), "c1", 2026, 9);
    expect(r).toEqual({ asentados: 3, revisados: 3 });
    expect(db.pares().map((p) => p.referenciaTipo)).toEqual(["HOSP_DEPOSITO_RECIBIDO", "HOSP_FARMACIA_SALIDA", "HOSP_HONORARIOS_RET_ISR"]);
    // La aplicación del depósito es de octubre: no se toca en septiembre.
    expect(db.pares().every((p) => p.month === 9)).toBe(true);

    expect(await asentarMes(comoDb(db), "c1", 2026, 9)).toEqual({ asentados: 0, revisados: 1 });
    const despues = await previewMes(comoDb(db), "c1", 2026, 9);
    expect(despues.asientos.map((a) => [a.referenciaTipo, a.asentado])).toEqual([
      ["HOSP_DEPOSITO_RECIBIDO", true],
      ["HOSP_FARMACIA_SALIDA", true],
      ["HOSP_HONORARIOS_RET_ISR", true],
    ]);

    // Octubre: sólo la aplicación del depósito.
    expect((await previewMes(comoDb(db), "c1", 2026, 10)).asientos.map((a) => a.referenciaTipo)).toEqual(["HOSP_DEPOSITO_APLICADO"]);
    expect(await asentarMes(comoDb(db), "c1", 2026, 10)).toEqual({ asentados: 1, revisados: 1 });
  });

  it("apagada: el preview sigue mostrando, asentar es 409", async () => {
    const db = armarMes(false);
    const p = await previewMes(comoDb(db), "c1", 2026, 9);
    expect(p.activa).toBe(false);
    expect(p.asientos).toHaveLength(3);
    await expect(asentarMes(comoDb(db), "c1", 2026, 9)).rejects.toMatchObject({ status: 409 });
    expect(db.asientos).toHaveLength(0);
  });
});
