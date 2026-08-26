import { describe, it, expect } from "vitest";
import {
  conciliarBancos,
  resumenConciliacion,
  type AsientoBancosParaConciliar,
  type ConciliarArgs,
  type MovimientoParaConciliar,
} from "./conciliacion";

const mov = (over: Partial<MovimientoParaConciliar> = {}): MovimientoParaConciliar => ({
  id: "t1",
  fecha: "2026-07-05",
  descripcion: "Pago cliente",
  monto: 1000,
  cuentaBancariaId: "b1",
  registrado: true,
  ...over,
});

const asiento = (over: Partial<AsientoBancosParaConciliar> = {}): AsientoBancosParaConciliar => ({
  id: "e1",
  fecha: "2026-07-05",
  concepto: "Pago cliente",
  delta: 1000,
  fuente: "BANCO",
  bankTxId: "t1",
  ...over,
});

/** Mes limpio: un depósito y un retiro, ambos posteados, saldos que cuadran. */
function mesLimpio(): ConciliarArgs {
  return {
    saldos: [{ cuentaBancariaId: "b1", etiqueta: "BBVA ***1234", saldoInicial: 5000, saldoFinal: 5600 }],
    movimientos: [
      mov({ id: "t1", monto: 1000 }),
      mov({ id: "t2", monto: -400, descripcion: "Pago proveedor" }),
    ],
    asientos: [
      asiento({ id: "e1", delta: 1000, bankTxId: "t1" }),
      asiento({ id: "e2", delta: -400, bankTxId: "t2" }),
    ],
    saldoInicialLibros: 5000,
    mesPosteado: true,
  };
}

describe("conciliarBancos — mes limpio", () => {
  it("cuadra sin partidas en conciliación", () => {
    const r = conciliarBancos(mesLimpio());
    expect(r.saldoEstadoCuenta).toBe(5600);
    expect(r.saldoLibros).toBe(5600);
    expect(r.saldoEsperadoLibros).toBe(5600);
    expect(r.diferencia).toBe(0);
    expect(r.conciliado).toBe(true);
    expect(r.movimientosNoRegistrados).toHaveLength(0);
    expect(r.asientosSinMovimiento).toHaveLength(0);
  });
});

describe("conciliarBancos — partidas en conciliación", () => {
  it("un movimiento sin registrar explica la diferencia y el mes sigue cuadrando", () => {
    const args = mesLimpio();
    // Llega un cargo de $250 que quedó UNMATCHED: está en el banco, no en libros.
    args.movimientos.push(mov({ id: "t3", monto: -250, descripcion: "Comisión", registrado: false }));
    args.saldos[0].saldoFinal = 5350; // 5,600 − 250

    const r = conciliarBancos(args);
    expect(r.movimientosNoRegistrados.map((m) => m.id)).toEqual(["t3"]);
    expect(r.totalNoRegistrados).toBe(-250);
    // 5,350 − (−250) = 5,600, que es justo lo que dice el libro.
    expect(r.saldoEsperadoLibros).toBe(5600);
    expect(r.saldoLibros).toBe(5600);
    expect(r.diferencia).toBe(0);
    expect(r.conciliado).toBe(true);
  });

  it("un asiento sin movimiento bancario también se explica", () => {
    const args = mesLimpio();
    // Póliza manual que toca Bancos sin movimiento del banco detrás.
    args.asientos.push(
      asiento({ id: "e3", delta: -800, concepto: "Ajuste manual", fuente: "MANUAL", bankTxId: null })
    );

    const r = conciliarBancos(args);
    expect(r.asientosSinMovimiento.map((a) => a.id)).toEqual(["e3"]);
    expect(r.totalAsientosSinMovimiento).toBe(-800);
    expect(r.saldoLibros).toBe(4800); // 5,600 − 800
    expect(r.saldoEsperadoLibros).toBe(4800); // 5,600 + (−800)
    expect(r.diferencia).toBe(0);
    expect(r.conciliado).toBe(true);
  });

  it("las partidas salen ordenadas por fecha", () => {
    const args = mesLimpio();
    args.movimientos.push(
      mov({ id: "z", fecha: "2026-07-28", monto: -10, registrado: false }),
      mov({ id: "a", fecha: "2026-07-02", monto: -20, registrado: false })
    );
    const r = conciliarBancos(args);
    expect(r.movimientosNoRegistrados.map((m) => m.id)).toEqual(["a", "z"]);
  });
});

describe("conciliarBancos — descuadres", () => {
  it("un saldo del estado que no corresponde deja diferencia sin explicar", () => {
    const args = mesLimpio();
    args.saldos[0].saldoFinal = 5900; // el banco dice 300 más
    const r = conciliarBancos(args);
    expect(r.diferencia).toBe(-300);
    expect(r.conciliado).toBe(false);
    expect(r.explicadaPorArrastre).toBe(false);
    expect(resumenConciliacion(r)).toContain("sin explicar");
  });

  it("la diferencia heredada del mes anterior se identifica como arrastre", () => {
    // El libro arrancó el mes 300 arriba del banco: el mes en sí está bien.
    const args = mesLimpio();
    args.saldoInicialLibros = 5300;
    const r = conciliarBancos(args);
    expect(r.diferenciaHeredada).toBe(300);
    expect(r.diferencia).toBe(300);
    expect(r.explicadaPorArrastre).toBe(true);
    expect(resumenConciliacion(r)).toContain("heredada");
  });

  it("respeta la tolerancia de redondeo", () => {
    const args = mesLimpio();
    args.saldos[0].saldoFinal = 5600.3;
    expect(conciliarBancos(args).conciliado).toBe(true);
    args.saldos[0].saldoFinal = 5601;
    expect(conciliarBancos(args).conciliado).toBe(false);
  });
});

describe("conciliarBancos — saldos faltantes", () => {
  it("sin saldo capturado no inventa un cuadre", () => {
    const args = mesLimpio();
    args.saldos[0].saldoFinal = null;
    const r = conciliarBancos(args);
    expect(r.saldoEstadoCuenta).toBeNull();
    expect(r.saldoEsperadoLibros).toBeNull();
    expect(r.diferencia).toBeNull();
    expect(r.conciliado).toBe(false);
    expect(r.cuentasSinSaldo).toEqual(["BBVA ***1234"]);
    expect(resumenConciliacion(r)).toContain("BBVA ***1234");
  });

  it("sin ninguna cuenta con saldo tampoco concilia", () => {
    const r = conciliarBancos({ ...mesLimpio(), saldos: [] });
    expect(r.saldoEstadoCuenta).toBeNull();
    expect(r.conciliado).toBe(false);
  });

  it("el saldo en libros SÍ se reporta aunque falte el del estado", () => {
    const args = mesLimpio();
    args.saldos[0].saldoFinal = null;
    expect(conciliarBancos(args).saldoLibros).toBe(5600);
  });
});

describe("conciliarBancos — varias cuentas bancarias", () => {
  it("suma los saldos de todas las cuentas contra el único auxiliar de Bancos", () => {
    // El catálogo tiene UNA cuenta contable de Bancos: su auxiliar es la suma.
    const r = conciliarBancos({
      saldos: [
        { cuentaBancariaId: "b1", etiqueta: "BBVA", saldoInicial: 5000, saldoFinal: 6000 },
        { cuentaBancariaId: "b2", etiqueta: "Santander", saldoInicial: 2000, saldoFinal: 1500 },
      ],
      movimientos: [
        mov({ id: "t1", monto: 1000, cuentaBancariaId: "b1" }),
        mov({ id: "t2", monto: -500, cuentaBancariaId: "b2" }),
      ],
      asientos: [
        asiento({ id: "e1", delta: 1000, bankTxId: "t1" }),
        asiento({ id: "e2", delta: -500, bankTxId: "t2" }),
      ],
      saldoInicialLibros: 7000,
    });
    expect(r.saldoEstadoCuenta).toBe(7500);
    expect(r.saldoLibros).toBe(7500);
    expect(r.conciliado).toBe(true);
  });

  it("basta que UNA cuenta no tenga saldo para no poder conciliar", () => {
    const r = conciliarBancos({
      saldos: [
        { cuentaBancariaId: "b1", etiqueta: "BBVA", saldoInicial: 5000, saldoFinal: 6000 },
        { cuentaBancariaId: "b2", etiqueta: "Santander", saldoInicial: null, saldoFinal: null },
      ],
      movimientos: [],
      asientos: [],
      saldoInicialLibros: 7000,
    });
    expect(r.cuentasSinSaldo).toEqual(["Santander"]);
    expect(r.diferencia).toBeNull();
  });
});

describe("conciliarBancos — mes sin postear", () => {
  it("un mes sin cerrar avisa que es trabajo pendiente, no partidas en conciliación", () => {
    // Caso real (SMP julio): 27 movimientos importados, mes sin cerrar. El
    // papel decía "27 no registrados", que numéricamente es cierto pero se lee
    // como 27 excepciones a investigar cuando en realidad falta cerrar el mes.
    const args = mesLimpio();
    args.asientos = []; // nada posteado todavía
    args.movimientos = args.movimientos.map((m) => ({ ...m, registrado: false }));
    args.mesPosteado = false;
    const r = conciliarBancos(args);
    expect(r.mesPosteado).toBe(false);
    expect(resumenConciliacion(r)).toContain("no se ha cerrado");
    expect(resumenConciliacion(r)).toContain("2 movimiento");
  });

  it("con el mes posteado el mismo estado se reporta como partidas normales", () => {
    const args = mesLimpio();
    args.mesPosteado = true;
    args.movimientos.push(mov({ id: "t3", monto: -250, registrado: false }));
    args.saldos[0].saldoFinal = 5350;
    const r = conciliarBancos(args);
    expect(r.mesPosteado).toBe(true);
    expect(resumenConciliacion(r)).not.toContain("no se ha cerrado");
    expect(resumenConciliacion(r)).toContain("1 partida");
  });

  it("un mes sin postear y sin movimientos no dispara el aviso de cierre", () => {
    const r = conciliarBancos({
      saldos: [{ cuentaBancariaId: "b1", etiqueta: "BBVA", saldoInicial: null, saldoFinal: null }],
      movimientos: [],
      asientos: [],
      saldoInicialLibros: 0,
      mesPosteado: false,
    });
    expect(resumenConciliacion(r)).toContain("Falta capturar el saldo");
  });
});

describe("resumenConciliacion", () => {
  it("distingue conciliado con y sin partidas", () => {
    expect(resumenConciliacion(conciliarBancos(mesLimpio()))).toContain("sin partidas pendientes");
    const conPartidas = mesLimpio();
    conPartidas.movimientos.push(mov({ id: "t3", monto: -250, registrado: false }));
    conPartidas.saldos[0].saldoFinal = 5350;
    expect(resumenConciliacion(conciliarBancos(conPartidas))).toContain("1 partida");
  });
});

describe("contraparte extraída", () => {
  it("SOBREVIVE el paso por el motor: la mesa la necesita para decir quién", () => {
    // El motor no usa la contraparte para conciliar — la arrastra. Este test
    // fija ese contrato: si alguien "limpia" el objeto al filtrar/ordenar, la
    // mesa vuelve a enseñar la sintaxis cruda del banco sin que nada truene.
    const r = conciliarBancos({
      saldos: [],
      movimientos: [
        mov({
          id: "t9", registrado: false,
          contraparteNombre: "CONSTRUCTORA DEL VALLE",
          contraparteRfc: "CVA010101AAA",
          conceptoPago: "Estimación 3",
          claveRastreo: "2026080412345678",
        }),
      ],
      asientos: [],
      saldoInicialLibros: 0,
    });
    const m = r.movimientosNoRegistrados[0];
    expect(m.contraparteNombre).toBe("CONSTRUCTORA DEL VALLE");
    expect(m.contraparteRfc).toBe("CVA010101AAA");
    expect(m.conceptoPago).toBe("Estimación 3");
    expect(m.claveRastreo).toBe("2026080412345678");
  });

  it("sin contraparte no pasa nada: el campo simplemente no viene", () => {
    const r = conciliarBancos({
      saldos: [], movimientos: [mov({ id: "t9", registrado: false })],
      asientos: [], saldoInicialLibros: 0,
    });
    expect(r.movimientosNoRegistrados[0].contraparteNombre).toBeUndefined();
  });
});
