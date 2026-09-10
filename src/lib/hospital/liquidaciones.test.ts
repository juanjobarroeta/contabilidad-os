import { describe, it, expect } from "vitest";
import {
  IVA_COMISION,
  TOLERANCIA_CUADRE,
  cobrosPendientes,
  comisionEsperada,
  cuadreDe,
  depositoEsperado,
  sugerirDias,
  validarLiquidacion,
} from "./liquidaciones";
import { HospitalError } from "./errores";
import { DbFalsa, comoDb } from "./__fixtures__/db-falsa";

// Un lote real: $10,000 brutos al 1.95 % de crédito.
const BRUTO = 10000;
const COMISION = 195;
const IVA = 31.2;
const NETO = 9773.8;

describe("cuadreDe() — bruto − contracargos − comisión − IVA = neto", () => {
  it("cuadra un lote limpio", () => {
    const c = cuadreDe({ bruto: BRUTO, contracargos: 0, comision: COMISION, ivaComision: IVA, neto: NETO });
    expect(c.diferencia).toBe(0);
    expect(c.cuadra).toBe(true);
  });

  it("cuadra con contracargo descontado del lote", () => {
    const c = cuadreDe({ bruto: BRUTO, contracargos: 1500, comision: COMISION, ivaComision: IVA, neto: NETO - 1500 });
    expect(c.cuadra).toBe(true);
  });

  it("un contracargo que el sistema no conoce deja la diferencia con nombre y monto", () => {
    // El adquirente descontó $1,500 que aquí no se registraron.
    const c = cuadreDe({ bruto: BRUTO, contracargos: 0, comision: COMISION, ivaComision: IVA, neto: NETO - 1500 });
    expect(c.cuadra).toBe(false);
    expect(c.diferencia).toBe(-1500);
  });

  it("acepta el redondeo del adquirente pero no un voucher faltante", () => {
    expect(cuadreDe({ bruto: BRUTO, contracargos: 0, comision: COMISION, ivaComision: IVA, neto: NETO + TOLERANCIA_CUADRE }).cuadra).toBe(true);
    expect(cuadreDe({ bruto: BRUTO, contracargos: 0, comision: COMISION, ivaComision: IVA, neto: NETO + 0.5 }).cuadra).toBe(false);
  });
});

describe("comisionEsperada() — la tasa pactada es para verificar, no para calcular", () => {
  it("aplica la tasa y le suma el IVA de la comisión", () => {
    expect(comisionEsperada(BRUTO, 0.0195)).toEqual({ comision: COMISION, ivaComision: IVA });
  });

  it("débito y AMEX no pagan lo mismo que crédito", () => {
    expect(comisionEsperada(BRUTO, 0.0155)!.comision).toBe(155);
    expect(comisionEsperada(BRUTO, 0.0285)!.comision).toBe(285);
  });

  it("sin tasa capturada no se inventa una", () => {
    expect(comisionEsperada(BRUTO, null)).toBeNull();
    expect(comisionEsperada(BRUTO, 0)).toBeNull();
  });

  it("el IVA de la comisión es a la tasa general", () => {
    expect(IVA_COMISION).toBe(0.16);
  });
});

describe("depositoEsperado() — cómo deposita no es cuánto cobra", () => {
  it("en bruto: el depósito ES la suma del día, aunque haya tasa pactada", () => {
    // Haltus: el reporte diario del adquirente cuadra al centavo con lo
    // depositado y la tasa se cobra en cargos aparte.
    expect(depositoEsperado(BRUTO, { liquidaEnBruto: true, tasa: 0.0195 })).toBe(BRUTO);
    expect(depositoEsperado(BRUTO, { liquidaEnBruto: true, tasa: null })).toBe(BRUTO);
  });

  it("en neto: descuenta la comisión y su IVA", () => {
    expect(depositoEsperado(BRUTO, { liquidaEnBruto: false, tasa: 0.0195 })).toBe(NETO);
  });

  it("neto sin tasa capturada no inventa un descuento", () => {
    expect(depositoEsperado(BRUTO, { liquidaEnBruto: false, tasa: null })).toBe(BRUTO);
  });
});

describe("sugerirDias() — propone, no adivina", () => {
  const cobros = [
    { id: "c1", fecha: new Date("2026-09-03T18:00:00Z"), monto: 4000 },
    { id: "c2", fecha: new Date("2026-09-03T20:00:00Z"), monto: 6000 },
    { id: "c3", fecha: new Date("2026-09-04T18:00:00Z"), monto: 2500 },
  ];
  const NETO_MODO = { liquidaEnBruto: false, tasa: 0.0195 };
  const BRUTO_MODO = { liquidaEnBruto: true, tasa: 0.0195 };

  it("agrupa por día de operación y pone primero el que explica el depósito", () => {
    const dias = sugerirDias(cobros, NETO, NETO_MODO);
    expect(dias[0].dia).toBe("2026-09-03");
    expect(dias[0].bruto).toBe(BRUTO);
    expect(dias[0].cobroIds).toEqual(["c1", "c2"]);
    expect(dias[0].distancia).toBe(0);
  });

  it("el día que no explica el depósito queda atrás, con su distancia a la vista", () => {
    const dias = sugerirDias(cobros, NETO, NETO_MODO);
    expect(dias[1].dia).toBe("2026-09-04");
    expect(dias[1].distancia).toBeGreaterThan(0);
  });

  it("con adquirente que liquida en bruto, el día correcto queda en cero", () => {
    // El caso de Haltus: el depósito ES la suma del día, sin comisión de por
    // medio. Es el mismo lote de $10,000, pero el banco recibe $10,000.
    const dias = sugerirDias(cobros, BRUTO, BRUTO_MODO);
    expect(dias[0].dia).toBe("2026-09-03");
    expect(dias[0].netoEsperado).toBe(BRUTO);
    expect(dias[0].distancia).toBe(0);
  });

  it("restarle una comisión que nadie descontó esconde el día correcto", () => {
    // Es el error que arreglamos: con la tasa aplicada a un adquirente que
    // deposita en bruto, el día que explica el depósito deja de tener
    // distancia cero y ya no se distingue del que no lo explica.
    const conTasa = sugerirDias(cobros, BRUTO, NETO_MODO);
    expect(conTasa[0].distancia).toBeGreaterThan(0);
    const enBruto = sugerirDias(cobros, BRUTO, BRUTO_MODO);
    expect(enBruto[0].distancia).toBe(0);
  });

  it("a igualdad de distancia manda el día más viejo: es el que ya debió depositarse", () => {
    const empatados = [
      { id: "a", fecha: new Date("2026-09-07T18:00:00Z"), monto: 500 },
      { id: "b", fecha: new Date("2026-09-02T18:00:00Z"), monto: 500 },
    ];
    const dias = sugerirDias(empatados, 500, BRUTO_MODO);
    expect(dias.map((d) => d.dia)).toEqual(["2026-09-02", "2026-09-07"]);
  });
});

describe("validarLiquidacion()", () => {
  const armar = async () => {
    const db = new DbFalsa();
    const base = { companyId: db.companyId, formaPago: "TARJETA", afiliacionId: "af1", estado: "COBRADO" };
    const c1 = await comoDb(db).hospCobro.create({ data: { ...base, fecha: new Date("2026-09-03T18:00:00Z"), monto: 4000, autorizacion: "111111" } });
    const c2 = await comoDb(db).hospCobro.create({ data: { ...base, fecha: new Date("2026-09-03T20:00:00Z"), monto: 6000, autorizacion: "222222" } });
    return { db, c1, c2 };
  };

  const input = (ids: string[], extra: Record<string, unknown> = {}) => ({
    afiliacionId: "af1",
    fecha: new Date("2026-09-05T12:00:00Z"),
    cobroIds: ids,
    bruto: BRUTO,
    contracargos: 0,
    comision: COMISION,
    ivaComision: IVA,
    neto: NETO,
    ...extra,
  });

  it("acepta el lote que cierra", async () => {
    const { db, c1, c2 } = await armar();
    const cuadre = await validarLiquidacion(comoDb(db), db.companyId, input([c1.id, c2.id]));
    expect(cuadre.cuadra).toBe(true);
    expect(cuadre.bruto).toBe(BRUTO);
  });

  it("no acepta una liquidación sin cobros", async () => {
    const { db } = await armar();
    await expect(validarLiquidacion(comoDb(db), db.companyId, input([]))).rejects.toThrow(/sin cobros/i);
  });

  it("dice qué falta cuando los vouchers no suman el bruto", async () => {
    const { db, c1 } = await armar();
    await expect(validarLiquidacion(comoDb(db), db.companyId, input([c1.id]))).rejects.toThrow(/Falta o sobra un voucher/i);
  });

  it("no deja meter un cobro de otra afiliación para forzar el cuadre", async () => {
    const { db, c1 } = await armar();
    const ajeno = await comoDb(db).hospCobro.create({
      data: { companyId: db.companyId, formaPago: "TARJETA", afiliacionId: "af2", estado: "COBRADO", fecha: new Date("2026-09-03T19:00:00Z"), monto: 6000, autorizacion: "333333" },
    });
    await expect(validarLiquidacion(comoDb(db), db.companyId, input([c1.id, ajeno.id]))).rejects.toThrow(/otra afiliación/i);
  });

  it("no deja liquidar dos veces el mismo cobro", async () => {
    const { db, c1, c2 } = await armar();
    await comoDb(db).hospCobro.update({ where: { id: c2.id }, data: { liquidacionId: "liq-vieja" } });
    await expect(validarLiquidacion(comoDb(db), db.companyId, input([c1.id, c2.id]))).rejects.toThrow(/ya pertenece a otra liquidación/i);
  });

  it("el adquirente sólo liquida tarjeta", async () => {
    const { db, c1 } = await armar();
    const efectivo = await comoDb(db).hospCobro.create({
      data: { companyId: db.companyId, formaPago: "EFECTIVO", afiliacionId: "af1", estado: "COBRADO", fecha: new Date("2026-09-03T19:00:00Z"), monto: 6000 },
    });
    await expect(validarLiquidacion(comoDb(db), db.companyId, input([c1.id, efectivo.id]))).rejects.toThrow(/sólo liquida cobros con tarjeta/i);
  });

  it("un cobro de otra empresa no existe para esta liquidación", async () => {
    const { db, c1 } = await armar();
    const otra = await comoDb(db).hospCobro.create({
      data: { companyId: "c2", formaPago: "TARJETA", afiliacionId: "af1", estado: "COBRADO", fecha: new Date("2026-09-03T19:00:00Z"), monto: 6000, autorizacion: "444444" },
    });
    await expect(validarLiquidacion(comoDb(db), db.companyId, input([c1.id, otra.id]))).rejects.toThrow(/no existe o es de otra empresa/i);
  });

  it("rechaza el lote cuyas cifras no cierran, con la diferencia en el mensaje", async () => {
    const { db, c1, c2 } = await armar();
    await expect(
      validarLiquidacion(comoDb(db), db.companyId, input([c1.id, c2.id], { neto: NETO - 1500 }))
    ).rejects.toThrow(/no cierra por -1500/i);
  });

  it("los errores son de negocio, con su código", async () => {
    const { db } = await armar();
    await expect(validarLiquidacion(comoDb(db), db.companyId, input([]))).rejects.toBeInstanceOf(HospitalError);
  });
});

describe("cobrosPendientes()", () => {
  it("trae los de la afiliación sin liquidar, dentro de la ventana del adquirente", async () => {
    const db = new DbFalsa();
    const base = { companyId: db.companyId, formaPago: "TARJETA", afiliacionId: "af1", estado: "COBRADO" };
    await comoDb(db).hospCobro.create({ data: { ...base, fecha: new Date("2026-09-03T18:00:00Z"), monto: 4000, autorizacion: "111111" } });
    // Ya liquidado: no vuelve a proponerse.
    await comoDb(db).hospCobro.create({ data: { ...base, fecha: new Date("2026-09-03T19:00:00Z"), monto: 500, autorizacion: "222222", liquidacionId: "liq1" } });
    // Fuera de la ventana de diez días.
    await comoDb(db).hospCobro.create({ data: { ...base, fecha: new Date("2026-08-01T18:00:00Z"), monto: 900, autorizacion: "333333" } });
    // De otra afiliación.
    await comoDb(db).hospCobro.create({ data: { ...base, afiliacionId: "af2", fecha: new Date("2026-09-03T18:00:00Z"), monto: 700, autorizacion: "444444" } });

    const pendientes = await cobrosPendientes(comoDb(db), db.companyId, "af1", new Date("2026-09-05T12:00:00Z"));
    expect(pendientes).toHaveLength(1);
    expect(pendientes[0].monto).toBe(4000);
  });
});
