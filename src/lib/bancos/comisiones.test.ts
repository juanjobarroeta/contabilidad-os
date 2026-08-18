import { describe, expect, it } from "vitest";
import { vincularComisiones, VENTANA_DIAS_COMISION, type MovimientoComision } from "./comisiones";

const D = (s: string) => new Date(`${s}T00:00:00Z`);

const mov = (o: Partial<MovimientoComision> & { id: string; monto: number }): MovimientoComision => ({
  fecha: D("2026-07-31"),
  descripcion: "SPEI Enviado: | Beneficiario: KATIA FABIOLA CORDERO BERNARDINO",
  ...o,
});

// El par REAL del estado de cuenta de Bajío: el envío y su comisión comparten
// clave de rastreo y referencia.
const ENVIO = mov({
  id: "envio",
  monto: -4725.6,
  claveRastreo: "BB27726020704",
  referencia: "2772602",
});
const COMISION = mov({
  id: "comision",
  monto: -7.42,
  descripcion: "Comision por Transferencia - Envio ; (SPEI; Banca por Internet)",
  claveRastreo: "BB27726020704",
  referencia: "2772602",
});

describe("vincularComisiones — el caso real de Bajío", () => {
  it("cuelga la comisión de su envío por clave de rastreo", () => {
    expect(vincularComisiones([ENVIO, COMISION])).toEqual([
      { comisionId: "comision", transferenciaId: "envio", por: "claveRastreo" },
    ]);
  });

  it("empata aunque la clave venga en distinta caja", () => {
    const c = { ...COMISION, claveRastreo: "bb27726020704" };
    expect(vincularComisiones([ENVIO, c])[0]?.transferenciaId).toBe("envio");
  });

  it("la clave de rastreo empata sin importar la distancia en días", () => {
    // El banco puede cobrar la comisión en el corte, días después. La clave es
    // concluyente por sí sola, así que no se le aplica ventana.
    const c = { ...COMISION, fecha: D("2026-08-15") };
    expect(vincularComisiones([ENVIO, c])[0]?.por).toBe("claveRastreo");
  });
});

describe("vincularComisiones — respaldo por referencia", () => {
  it("empata por referencia cuando no hay clave de rastreo", () => {
    const e = { ...ENVIO, claveRastreo: null };
    const c = { ...COMISION, claveRastreo: null };
    expect(vincularComisiones([e, c])[0]).toEqual({
      comisionId: "comision",
      transferenciaId: "envio",
      por: "referencia",
    });
  });

  it("la referencia SÍ tiene ventana: se repite entre meses y entre bancos", () => {
    const e = { ...ENVIO, claveRastreo: null };
    const c = { ...COMISION, claveRastreo: null, fecha: D("2026-08-20") };
    expect(vincularComisiones([e, c])).toEqual([]);
  });

  it("dentro de la ventana sí empata", () => {
    const e = { ...ENVIO, claveRastreo: null };
    const c = {
      ...COMISION,
      claveRastreo: null,
      fecha: new Date(ENVIO.fecha.getTime() + VENTANA_DIAS_COMISION * 86_400_000),
    };
    expect(vincularComisiones([e, c])).toHaveLength(1);
  });
});

describe("vincularComisiones — los candados", () => {
  it("la comisión NUNCA es mayor que su transferencia", () => {
    // Sin este candado, dos envíos que compartieran referencia podrían
    // emparejarse entre sí y "desaparecer" un pago real de la conciliación.
    const chico = mov({ id: "chico", monto: -5, claveRastreo: "BB1", referencia: "1" });
    const comisionGrande = mov({
      id: "cg",
      monto: -900,
      descripcion: "Comision por Transferencia",
      claveRastreo: "BB1",
    });
    expect(vincularComisiones([chico, comisionGrande])).toEqual([]);
  });

  it("no cuelga una comisión de un DEPÓSITO", () => {
    const deposito = mov({ id: "dep", monto: 4725.6, claveRastreo: "BB27726020704" });
    expect(vincularComisiones([deposito, COMISION])).toEqual([]);
  });

  it("no empareja dos comisiones entre sí", () => {
    const otra = { ...COMISION, id: "otra", monto: -3 };
    expect(vincularComisiones([COMISION, otra])).toEqual([]);
  });

  it("ante un empate perfecto NO adivina", () => {
    // Colgar la comisión de la transferencia equivocada es peor que dejarla
    // suelta: cambia de qué gasto se está hablando.
    const a = mov({ id: "a", monto: -1000, claveRastreo: "BB9", fecha: D("2026-07-30") });
    const b = mov({ id: "b", monto: -1000, claveRastreo: "BB9", fecha: D("2026-08-01") });
    const c = mov({
      id: "c",
      monto: -7,
      descripcion: "Comision por Transferencia",
      claveRastreo: "BB9",
      fecha: D("2026-07-31"), // equidistante de a y b
    });
    expect(vincularComisiones([a, b, c])).toEqual([]);
  });

  it("con dos candidatas a distinta distancia gana la más cercana", () => {
    const lejos = mov({ id: "lejos", monto: -1000, claveRastreo: "BB9", fecha: D("2026-07-20") });
    const cerca = mov({ id: "cerca", monto: -1000, claveRastreo: "BB9", fecha: D("2026-07-31") });
    const c = mov({
      id: "c",
      monto: -7,
      descripcion: "Comision por Transferencia",
      claveRastreo: "BB9",
      fecha: D("2026-07-31"),
    });
    expect(vincularComisiones([lejos, cerca, c])[0]?.transferenciaId).toBe("cerca");
  });
});

describe("vincularComisiones — no rompe", () => {
  it("sin movimientos, sin comisiones o sin transferencias devuelve vacío", () => {
    expect(vincularComisiones([])).toEqual([]);
    expect(vincularComisiones([ENVIO])).toEqual([]);
    expect(vincularComisiones([COMISION])).toEqual([]);
  });

  it("una comisión sin clave ni referencia no empata con nada", () => {
    const c = { ...COMISION, claveRastreo: null, referencia: null };
    expect(vincularComisiones([ENVIO, c])).toEqual([]);
  });
});
