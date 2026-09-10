import { describe, it, expect } from "vitest";
import {
  TRANSICIONES_COBRO,
  buscarDuplicado,
  corteDeCaja,
  fondosEnTransitoPendientes,
  esVigente,
  llaveCobro,
  normalizarAutorizacion,
  normalizarUltimos4,
  puedeTransicionar,
  validarCobro,
} from "./cobros";
import { HospitalError } from "./errores";
import { DbFalsa, comoDb } from "./__fixtures__/db-falsa";

const FECHA = new Date("2026-09-05T18:30:00Z");
const F1 = new Date("2026-09-05T18:00:00Z");
const F2 = new Date("2026-09-07T12:00:00Z");

const tarjeta = (extra: Record<string, unknown> = {}) => ({
  fecha: FECHA,
  monto: 1200,
  formaPago: "TARJETA" as const,
  episodioId: "ep1",
  afiliacionId: "af1",
  autorizacion: "123456",
  marca: "VISA" as const,
  tipoTarjeta: "CREDITO" as const,
  ultimos4: "4242",
  ...extra,
});

describe("validarCobro() — el candado de la terminal", () => {
  it("acepta un cobro con tarjeta completo", () => {
    const v = validarCobro(tarjeta());
    expect(v.monto).toBe(1200);
    expect(v.autorizacion).toBe("123456");
    expect(v.ultimos4).toBe("4242");
  });

  it.each([
    ["afiliacionId", "afiliación"],
    ["autorizacion", "autorización"],
    ["marca", "marca"],
    ["tipoTarjeta", "crédito o débito"],
    ["ultimos4", "cuatro"],
  ])("no guarda un cobro con tarjeta sin %s", (campo, mensaje) => {
    expect(() => validarCobro(tarjeta({ [campo]: null }))).toThrow(HospitalError);
    expect(() => validarCobro(tarjeta({ [campo]: null }))).toThrow(new RegExp(mensaje, "i"));
  });

  it("limpia los campos de terminal cuando no es tarjeta: la llave no lleva basura", () => {
    const v = validarCobro(tarjeta({ formaPago: "EFECTIVO", referencia: "  " }));
    expect(v.afiliacionId).toBeNull();
    expect(v.autorizacion).toBeNull();
    expect(v.marca).toBeNull();
    expect(v.tipoTarjeta).toBeNull();
    expect(v.ultimos4).toBeNull();
    expect(v.referencia).toBeNull();
  });

  it("exige que el cobro diga a qué entra", () => {
    expect(() => validarCobro(tarjeta({ episodioId: null, invoiceId: null, depositoId: null }))).toThrow(
      /episodio, a una factura o a un anticipo/i
    );
  });

  it("basta con la factura o el anticipo, sin episodio", () => {
    expect(validarCobro(tarjeta({ episodioId: null, invoiceId: "inv1" })).invoiceId).toBe("inv1");
    expect(validarCobro(tarjeta({ episodioId: null, depositoId: "dep1" })).depositoId).toBe("dep1");
  });

  it("rechaza monto cero o negativo", () => {
    expect(() => validarCobro(tarjeta({ monto: 0 }))).toThrow(/mayor que cero/i);
    expect(() => validarCobro(tarjeta({ monto: -50 }))).toThrow(/mayor que cero/i);
  });
});

describe("normalizarAutorizacion()", () => {
  it("acepta los seis dígitos del voucher y el alfanumérico de AMEX", () => {
    expect(normalizarAutorizacion("123456")).toBe("123456");
    expect(normalizarAutorizacion(" a1b2c3 ")).toBe("A1B2C3");
  });

  it("rechaza lo que no puede venir de un voucher", () => {
    expect(() => normalizarAutorizacion("")).toThrow(HospitalError);
    expect(() => normalizarAutorizacion("12")).toThrow(HospitalError);
    expect(() => normalizarAutorizacion("123456789")).toThrow(HospitalError);
    expect(() => normalizarAutorizacion("12-345")).toThrow(HospitalError);
  });
});

describe("normalizarUltimos4()", () => {
  it("son exactamente cuatro números", () => {
    expect(normalizarUltimos4("4242")).toBe("4242");
    expect(() => normalizarUltimos4("424")).toThrow(HospitalError);
    expect(() => normalizarUltimos4("42424")).toThrow(HospitalError);
    expect(() => normalizarUltimos4("4z42")).toThrow(HospitalError);
  });
});

describe("llaveCobro() — la autorización sola no identifica", () => {
  it("junta afiliación, día de operación, monto y autorización", () => {
    expect(llaveCobro({ afiliacionId: "af1", fecha: FECHA, monto: 1200, autorizacion: "123456" })).toBe(
      "af1|2026-09-05|1200.00|123456"
    );
  });

  it("la misma autorización en otra afiliación es otro cobro", () => {
    const a = llaveCobro({ afiliacionId: "af1", fecha: FECHA, monto: 1200, autorizacion: "123456" });
    const b = llaveCobro({ afiliacionId: "af2", fecha: FECHA, monto: 1200, autorizacion: "123456" });
    expect(a).not.toBe(b);
  });

  it("la misma autorización por otro monto es otro cobro", () => {
    const a = llaveCobro({ afiliacionId: "af1", fecha: FECHA, monto: 1200, autorizacion: "123456" });
    const b = llaveCobro({ afiliacionId: "af1", fecha: FECHA, monto: 1200.5, autorizacion: "123456" });
    expect(a).not.toBe(b);
  });

  it("la hora no parte el día: caja teclea el lunes lo del sábado", () => {
    const manana = new Date("2026-09-05T14:00:00Z");
    const noche = new Date("2026-09-05T23:00:00Z");
    expect(llaveCobro({ afiliacionId: "af1", fecha: manana, monto: 1200, autorizacion: "123456" })).toBe(
      llaveCobro({ afiliacionId: "af1", fecha: noche, monto: 1200, autorizacion: "123456" })
    );
  });

  it("sin terminal no hay llave", () => {
    expect(llaveCobro({ afiliacionId: null, fecha: FECHA, monto: 100, autorizacion: null })).toBeNull();
  });
});

describe("buscarDuplicado()", () => {
  const sembrar = async (db: DbFalsa) => {
    await comoDb(db).hospCobro.create({
      data: { companyId: db.companyId, fecha: FECHA, monto: 1200, formaPago: "TARJETA", afiliacionId: "af1", autorizacion: "123456", estado: "COBRADO" },
    });
  };

  it("encuentra la recaptura del mismo voucher", async () => {
    const db = new DbFalsa();
    await sembrar(db);
    const dup = await buscarDuplicado(comoDb(db), db.companyId, { afiliacionId: "af1", fecha: FECHA, monto: 1200, autorizacion: "123456" });
    expect(dup).not.toBeNull();
  });

  it("otra hora del mismo día sigue siendo el mismo cobro", async () => {
    const db = new DbFalsa();
    await sembrar(db);
    const dup = await buscarDuplicado(comoDb(db), db.companyId, {
      afiliacionId: "af1",
      fecha: new Date("2026-09-05T09:00:00Z"),
      monto: 1200,
      autorizacion: "123456",
    });
    expect(dup).not.toBeNull();
  });

  it("otro día, otro monto u otra afiliación no son duplicado", async () => {
    const db = new DbFalsa();
    await sembrar(db);
    const otroDia = await buscarDuplicado(comoDb(db), db.companyId, { afiliacionId: "af1", fecha: new Date("2026-09-06T18:30:00Z"), monto: 1200, autorizacion: "123456" });
    const otroMonto = await buscarDuplicado(comoDb(db), db.companyId, { afiliacionId: "af1", fecha: FECHA, monto: 1300, autorizacion: "123456" });
    const otraAfiliacion = await buscarDuplicado(comoDb(db), db.companyId, { afiliacionId: "af2", fecha: FECHA, monto: 1200, autorizacion: "123456" });
    expect(otroDia).toBeNull();
    expect(otroMonto).toBeNull();
    expect(otraAfiliacion).toBeNull();
  });

  it("un cobro cancelado no bloquea la recaptura: para eso se cancela", async () => {
    const db = new DbFalsa();
    await comoDb(db).hospCobro.create({
      data: { companyId: db.companyId, fecha: FECHA, monto: 1200, formaPago: "TARJETA", afiliacionId: "af1", autorizacion: "123456", estado: "CANCELADO" },
    });
    const dup = await buscarDuplicado(comoDb(db), db.companyId, { afiliacionId: "af1", fecha: FECHA, monto: 1200, autorizacion: "123456" });
    expect(dup).toBeNull();
  });
});

describe("TRANSICIONES_COBRO", () => {
  it("un cobro ya depositado todavía puede contracargarse", () => {
    expect(puedeTransicionar("DEPOSITADO", "CONTRACARGADO")).toBe(true);
  });

  it("un contracargo se puede ganar, pero no volver a cobrar", () => {
    expect(puedeTransicionar("CONTRACARGADO", "RECUPERADO")).toBe(true);
    expect(puedeTransicionar("CONTRACARGADO", "DEPOSITADO")).toBe(false);
  });

  it("cancelar es sólo para lo recién capturado", () => {
    expect(puedeTransicionar("COBRADO", "CANCELADO")).toBe(true);
    expect(puedeTransicionar("DEPOSITADO", "CANCELADO")).toBe(false);
  });

  it("no se puede depositar dos veces", () => {
    expect(TRANSICIONES_COBRO.DEPOSITADO).not.toContain("DEPOSITADO");
    expect(TRANSICIONES_COBRO.RECUPERADO).toEqual([]);
    expect(TRANSICIONES_COBRO.CANCELADO).toEqual([]);
  });

  it("vigente es lo que sigue siendo dinero del hospital", () => {
    expect(esVigente("COBRADO")).toBe(true);
    expect(esVigente("DEPOSITADO")).toBe(true);
    expect(esVigente("RECUPERADO")).toBe(true);
    expect(esVigente("CONTRACARGADO")).toBe(false);
    expect(esVigente("CANCELADO")).toBe(false);
  });
});

describe("corteDeCaja()", () => {
  it("separa lo que caja entrega en mano de lo que va en tránsito", () => {
    const c = corteDeCaja([
      { monto: 500, formaPago: "EFECTIVO", estado: "COBRADO" },
      { monto: 1200, formaPago: "TARJETA", estado: "COBRADO" },
      { monto: 800, formaPago: "TARJETA", estado: "DEPOSITADO" },
      { monto: 300, formaPago: "TRANSFERENCIA", estado: "COBRADO" },
      { monto: 250, formaPago: "CHEQUE", estado: "COBRADO" },
    ]);
    expect(c.enCaja).toBe(500);
    expect(c.enTransito).toBe(2550);
    expect(c.total).toBe(3050);
  });

  it("el contracargo no cuenta en el total y se informa aparte", () => {
    const c = corteDeCaja([
      { monto: 1000, formaPago: "TARJETA", estado: "COBRADO" },
      { monto: 400, formaPago: "TARJETA", estado: "CONTRACARGADO" },
      { monto: 99, formaPago: "EFECTIVO", estado: "CANCELADO" },
    ]);
    expect(c.tarjeta).toBe(1000);
    expect(c.total).toBe(1000);
    expect(c.contracargos).toBe(400);
  });
});

describe("fondosEnTransitoPendientes() — lo que 107.05 debe", () => {
  const armar = async () => {
    const db = new DbFalsa();
    const c = comoDb(db);
    // Efectivo: va a CAJA, el banco no lo ve.
    await c.hospCobro.create({ data: { companyId: db.companyId, fecha: F1, monto: 500, formaPago: "EFECTIVO", estado: "COBRADO" } });
    // Pendiente: cobrado y sin liquidación.
    await c.hospCobro.create({ data: { companyId: db.companyId, fecha: F1, monto: 1200, formaPago: "TARJETA", estado: "COBRADO", afiliacionId: "af1" } });
    // Pendiente: en una liquidación que todavía no tiene movimiento bancario.
    await c.hospLiquidacion.create({ data: { id: "liqSin", companyId: db.companyId, afiliacionId: "af1", fecha: F2, bruto: 800, comision: 0, ivaComision: 0, neto: 800 } });
    await c.hospCobro.create({ data: { companyId: db.companyId, fecha: F1, monto: 800, formaPago: "TARJETA", estado: "DEPOSITADO", afiliacionId: "af1", liquidacionId: "liqSin" } });
    // Ya no pendiente: su liquidación está conciliada contra el banco.
    await c.hospLiquidacion.create({ data: { id: "liqCon", companyId: db.companyId, afiliacionId: "af1", fecha: F2, bruto: 900, comision: 0, ivaComision: 0, neto: 900, bankTransactionId: "bt1" } });
    await c.hospCobro.create({ data: { companyId: db.companyId, fecha: F1, monto: 900, formaPago: "TARJETA", estado: "DEPOSITADO", afiliacionId: "af1", liquidacionId: "liqCon" } });
    // Contracargado: ya se acreditó con su reversa.
    await c.hospCobro.create({ data: { companyId: db.companyId, fecha: F1, monto: 400, formaPago: "TARJETA", estado: "CONTRACARGADO", afiliacionId: "af1" } });
    // Ligado a un anticipo: lo aporta el depósito, no el cobro.
    await c.hospCobro.create({ data: { companyId: db.companyId, fecha: F1, monto: 700, formaPago: "TARJETA", estado: "COBRADO", afiliacionId: "af1", depositoId: "dep1" } });
    // Depósitos: RECIBIDO y APLICADO siguen en tránsito; DEVUELTO ya se acreditó.
    await c.hospDeposito.create({ data: { id: "dep1", companyId: db.companyId, episodioId: "ep1", fecha: F1, monto: 700, formaPago: "TARJETA", estado: "RECIBIDO" } });
    await c.hospDeposito.create({ data: { companyId: db.companyId, episodioId: "ep1", fecha: F1, monto: 300, formaPago: "TRANSFERENCIA", estado: "APLICADO" } });
    await c.hospDeposito.create({ data: { companyId: db.companyId, episodioId: "ep1", fecha: F1, monto: 250, formaPago: "CHEQUE", estado: "DEVUELTO" } });
    await c.hospDeposito.create({ data: { companyId: db.companyId, episodioId: "ep1", fecha: F1, monto: 100, formaPago: "EFECTIVO", estado: "RECIBIDO" } });
    return db;
  };

  it("suma sólo lo que se cargó a 107.05 y nadie ha acreditado", async () => {
    const db = await armar();
    const f = await fondosEnTransitoPendientes(comoDb(db), db.companyId, new Date("2026-09-30T00:00:00Z"));
    // 1200 (sin liquidar) + 800 (liquidación sin banco) + 700 y 300 (depósitos)
    expect(f.saldo).toBe(3000);
    expect(f.cobros).toHaveLength(4);
    expect(f.cobros.filter((x) => x.origen === "DEPOSITO")).toHaveLength(2);
  });

  it("no cuenta el efectivo: ése entra a CAJA", async () => {
    const db = await armar();
    const f = await fondosEnTransitoPendientes(comoDb(db), db.companyId, new Date("2026-09-30T00:00:00Z"));
    expect(f.cobros.some((x) => x.formaPago === "EFECTIVO")).toBe(false);
  });

  it("respeta el corte de fecha", async () => {
    const db = await armar();
    const f = await fondosEnTransitoPendientes(comoDb(db), db.companyId, new Date("2026-09-01T00:00:00Z"));
    expect(f.saldo).toBe(0);
  });

  it("los entrega en FIFO, que es como la conciliación los va cubriendo", async () => {
    const db = new DbFalsa();
    for (const [dia, monto] of [["2026-09-08", 300], ["2026-09-02", 100], ["2026-09-05", 200]] as const) {
      await comoDb(db).hospCobro.create({
        data: { companyId: db.companyId, fecha: new Date(`${dia}T18:00:00Z`), monto, formaPago: "TARJETA", estado: "COBRADO" },
      });
    }
    const f = await fondosEnTransitoPendientes(comoDb(db), db.companyId, new Date("2026-09-30T00:00:00Z"));
    expect(f.cobros.map((x) => x.monto)).toEqual([100, 200, 300]);
  });
});
