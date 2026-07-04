import { describe, it, expect } from "vitest";
import {
  verificarBalance,
  resolverCuentaDestino,
  decidirIngesta,
  interpretarRespuestaSeleccion,
  mensajeResumenImportacion,
  mensajeSeleccionCuenta,
  ultimos4Digitos,
  serializarMovimientos,
  deserializarMovimientos,
  type CuentaCandidata,
} from "./estado-cuenta";
import type { ParsedTransaction } from "@/lib/bank-parser";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const tx = (monto: number, descripcion = "Movimiento"): ParsedTransaction => ({
  fecha: new Date("2026-06-15T12:00:00"),
  descripcion,
  monto,
});

const cuenta = (over: Partial<CuentaCandidata>): CuentaCandidata => ({
  id: "acc1",
  banco: "BBVA",
  nombre: "Cheques",
  numeroCuenta: "0123456789",
  clabe: null,
  ...over,
});

// ── Candado de balance (goldens) ─────────────────────────────────────────────

describe("verificarBalance", () => {
  it("CUADRA cuando inicial + movimientos = final exacto", () => {
    const r = verificarBalance({ saldoInicial: 1000, saldoFinal: 1500, montos: [800, -300] });
    expect(r).toEqual({ estado: "CUADRA", esperado: 1500, diferencia: 0 });
  });

  it("CUADRA dentro de la tolerancia de $1.00 (redondeos)", () => {
    const r = verificarBalance({ saldoInicial: 1000, saldoFinal: 1500.99, montos: [800, -300] });
    expect(r.estado).toBe("CUADRA");
  });

  it("NO_CUADRA apenas se excede la tolerancia", () => {
    const r = verificarBalance({ saldoInicial: 1000, saldoFinal: 1501.01, montos: [800, -300] });
    expect(r.estado).toBe("NO_CUADRA");
    if (r.estado === "NO_CUADRA") {
      expect(r.esperado).toBe(1500);
      expect(r.diferencia).toBe(-1.01);
    }
  });

  it("NO_CUADRA cuando faltan movimientos en la lectura", () => {
    const r = verificarBalance({ saldoInicial: 5000, saldoFinal: 3000, montos: [-500] });
    expect(r.estado).toBe("NO_CUADRA");
    if (r.estado === "NO_CUADRA") expect(r.diferencia).toBe(1500);
  });

  it("sin movimientos: CUADRA sólo si los saldos son iguales", () => {
    expect(verificarBalance({ saldoInicial: 100, saldoFinal: 100, montos: [] }).estado).toBe("CUADRA");
    expect(verificarBalance({ saldoInicial: 100, saldoFinal: 200, montos: [] }).estado).toBe("NO_CUADRA");
  });

  it("SIN_SALDOS cuando falta cualquiera de los dos saldos", () => {
    expect(verificarBalance({ saldoInicial: null, saldoFinal: 100, montos: [1] }).estado).toBe("SIN_SALDOS");
    expect(verificarBalance({ saldoInicial: 100, saldoFinal: null, montos: [1] }).estado).toBe("SIN_SALDOS");
    expect(verificarBalance({ saldoInicial: null, saldoFinal: null, montos: [] }).estado).toBe("SIN_SALDOS");
  });

  it("suma con centavos flotantes sin error de redondeo binario", () => {
    // 0.1 + 0.2 = 0.30000000000000004 — el candado redondea a centavos.
    const r = verificarBalance({ saldoInicial: 0, saldoFinal: 0.3, montos: [0.1, 0.2] });
    expect(r.estado).toBe("CUADRA");
  });
});

// ── Resolución de cuenta destino ─────────────────────────────────────────────

describe("resolverCuentaDestino", () => {
  const c1 = cuenta({ id: "a", numeroCuenta: "0011223344" });
  const c2 = cuenta({ id: "b", banco: "Banorte", nombre: "Nómina", numeroCuenta: "9988776655" });

  it("cero cuentas → NINGUNA", () => {
    expect(resolverCuentaDestino([], "1234").tipo).toBe("NINGUNA");
  });

  it("una sola cuenta → UNICA (sin importar el número extraído)", () => {
    const r = resolverCuentaDestino([c1], null);
    expect(r.tipo).toBe("UNICA");
    if (r.tipo === "UNICA") expect(r.cuenta.id).toBe("a");
  });

  it("varias cuentas y terminación que coincide con exactamente una → MATCH_ULTIMOS4", () => {
    const r = resolverCuentaDestino([c1, c2], "****6655");
    expect(r.tipo).toBe("MATCH_ULTIMOS4");
    if (r.tipo === "MATCH_ULTIMOS4") {
      expect(r.cuenta.id).toBe("b");
      expect(r.ultimos4).toBe("6655");
    }
  });

  it("coincidencia por CLABE también cuenta", () => {
    const conClabe = cuenta({ id: "c", numeroCuenta: "555", clabe: "012180001234567897" });
    const r = resolverCuentaDestino([c1, conClabe], "cuenta 7897");
    expect(r.tipo).toBe("MATCH_ULTIMOS4");
    if (r.tipo === "MATCH_ULTIMOS4") expect(r.cuenta.id).toBe("c");
  });

  it("terminación ambigua (dos cuentas coinciden) → VARIAS", () => {
    const dup = cuenta({ id: "d", numeroCuenta: "7700223344" }); // misma terminación que c1
    const r = resolverCuentaDestino([c1, dup], "3344");
    expect(r.tipo).toBe("VARIAS");
  });

  it("varias cuentas sin número extraído (o sin coincidencia) → VARIAS", () => {
    expect(resolverCuentaDestino([c1, c2], null).tipo).toBe("VARIAS");
    expect(resolverCuentaDestino([c1, c2], "0000").tipo).toBe("VARIAS");
  });

  it("números con menos de 4 dígitos no producen match", () => {
    expect(resolverCuentaDestino([c1, c2], "44").tipo).toBe("VARIAS");
  });
});

describe("ultimos4Digitos", () => {
  it("ignora separadores y asteriscos", () => {
    expect(ultimos4Digitos("**** **** 1234")).toBe("1234");
    expect(ultimos4Digitos("012-345-6789")).toBe("6789");
    expect(ultimos4Digitos("12")).toBeNull();
    expect(ultimos4Digitos(null)).toBeNull();
  });
});

// ── Decisión de ingesta (candado + cuenta) ───────────────────────────────────

describe("decidirIngesta", () => {
  const extr = (over: Partial<Parameters<typeof decidirIngesta>[0]>) => ({
    banco: "BBVA",
    numeroCuenta: "0123456789",
    periodo: "junio 2026",
    transactions: [tx(800), tx(-300)],
    saldoInicial: 1000,
    saldoFinal: 1500,
    ...over,
  });
  const unaCuenta = [cuenta({})];
  const dosCuentas = [cuenta({ id: "a", numeroCuenta: "0011" }), cuenta({ id: "b", numeroCuenta: "9922334455" })];

  it("sin movimientos → SIN_MOVIMIENTOS, no se importa", () => {
    const d = decidirIngesta(extr({ transactions: [] }), unaCuenta);
    expect(d.accion).toBe("SIN_MOVIMIENTOS");
  });

  it("saldos ausentes → BALANCE_NO_VERIFICABLE (nunca ingerir a ciegas)", () => {
    const d = decidirIngesta(extr({ saldoInicial: null }), unaCuenta);
    expect(d.accion).toBe("BALANCE_NO_VERIFICABLE");
  });

  it("balance que no cuadra → BALANCE_NO_CUADRA con el detalle del descuadre", () => {
    const d = decidirIngesta(extr({ saldoFinal: 9000 }), unaCuenta);
    expect(d.accion).toBe("BALANCE_NO_CUADRA");
    if (d.accion === "BALANCE_NO_CUADRA") {
      expect(d.mensaje).toContain("no cuadra");
      expect(d.mensaje).toContain("No importé nada");
      expect(d.mensaje).toMatch(/\$9,000\.00/); // reporta el saldo del estado
      expect(d.mensaje).toMatch(/\$1,500\.00/); // y el esperado calculado
    }
  });

  it("balance OK + una cuenta → IMPORTAR directo, sin nota", () => {
    const d = decidirIngesta(extr({}), unaCuenta);
    expect(d.accion).toBe("IMPORTAR");
    if (d.accion === "IMPORTAR") {
      expect(d.cuenta.id).toBe("acc1");
      expect(d.notaCuenta).toBeNull();
    }
  });

  it("balance OK + varias cuentas + terminación única → IMPORTAR con nota de auto-asignación", () => {
    const d = decidirIngesta(extr({ numeroCuenta: "***4455" }), dosCuentas);
    expect(d.accion).toBe("IMPORTAR");
    if (d.accion === "IMPORTAR") {
      expect(d.cuenta.id).toBe("b");
      expect(d.notaCuenta).toContain("4455");
    }
  });

  it("balance OK + varias cuentas sin match → ELEGIR_CUENTA con lista numerada", () => {
    const d = decidirIngesta(extr({ numeroCuenta: null }), dosCuentas);
    expect(d.accion).toBe("ELEGIR_CUENTA");
    if (d.accion === "ELEGIR_CUENTA") {
      expect(d.cuentas).toHaveLength(2);
      expect(d.mensaje).toContain("1)");
      expect(d.mensaje).toContain("2)");
      expect(d.mensaje).toContain("Responde con el número");
    }
  });

  it("balance OK pero cero cuentas → SIN_CUENTAS con instrucción de /bancos", () => {
    const d = decidirIngesta(extr({}), []);
    expect(d.accion).toBe("SIN_CUENTAS");
    if (d.accion === "SIN_CUENTAS") expect(d.mensaje).toContain("Bancos");
  });

  it("el candado va ANTES que la cuenta: sin cuentas Y balance roto reporta el balance", () => {
    const d = decidirIngesta(extr({ saldoFinal: 9999 }), []);
    expect(d.accion).toBe("BALANCE_NO_CUADRA");
  });
});

// ── Respuesta a la selección de cuenta ───────────────────────────────────────

describe("interpretarRespuestaSeleccion", () => {
  it("número en rango → SELECCION 0-based", () => {
    expect(interpretarRespuestaSeleccion("2", 3)).toEqual({ tipo: "SELECCION", indice: 1 });
    expect(interpretarRespuestaSeleccion(" 1 ", 3)).toEqual({ tipo: "SELECCION", indice: 0 });
  });

  it("número fuera de rango → FUERA_DE_RANGO (0 y > n)", () => {
    expect(interpretarRespuestaSeleccion("0", 3).tipo).toBe("FUERA_DE_RANGO");
    expect(interpretarRespuestaSeleccion("4", 3).tipo).toBe("FUERA_DE_RANGO");
  });

  it("cancelar / no → CANCELAR", () => {
    expect(interpretarRespuestaSeleccion("cancelar", 3).tipo).toBe("CANCELAR");
    expect(interpretarRespuestaSeleccion("Cancela eso", 3).tipo).toBe("CANCELAR");
    expect(interpretarRespuestaSeleccion("no", 3).tipo).toBe("CANCELAR");
  });

  it("cualquier otro texto → OTRO (recordatorio, no ejecuta)", () => {
    expect(interpretarRespuestaSeleccion("¿cuál me conviene?", 3).tipo).toBe("OTRO");
    expect(interpretarRespuestaSeleccion("la 2", 3).tipo).toBe("OTRO");
  });
});

// ── Formato de mensajes ──────────────────────────────────────────────────────

describe("mensajes", () => {
  it("resumen de importación con la forma pactada", () => {
    const msg = mensajeResumenImportacion({
      banco: "BBVA",
      periodo: "junio 2026",
      importados: 42,
      yaExistian: 3,
      descartadas: [],
      saldoVerificado: true,
    });
    expect(msg).toBe(
      "Recibí tu estado de cuenta de BBVA (junio 2026): 42 movimientos importados, " +
        "3 ya existían, 0 filas descartadas. El saldo cuadra. Revísalos en Bancos o pídeme conciliarlos."
    );
  });

  it("resumen incluye motivos de descartadas (máximo 3) y omite 'el saldo cuadra' sin verificación", () => {
    const msg = mensajeResumenImportacion({
      banco: null,
      periodo: null,
      importados: 10,
      yaExistian: 0,
      descartadas: [
        { fila: 5, motivo: "monto ausente" },
        { fila: 8, motivo: "fecha inválida: 99/99" },
        { fila: 9, motivo: "monto inválido: abc" },
        { fila: 12, motivo: "fecha ausente" },
      ],
      saldoVerificado: false,
    });
    expect(msg).toContain("4 filas descartadas");
    expect(msg).toContain("fila 5: monto ausente");
    expect(msg).toContain("entre otras");
    expect(msg).not.toContain("fila 12");
    expect(msg).not.toContain("El saldo cuadra");
  });

  it("la nota de cuenta auto-asignada se agrega al resumen", () => {
    const msg = mensajeResumenImportacion({
      banco: "Banorte",
      periodo: null,
      importados: 1,
      yaExistian: 0,
      descartadas: [],
      saldoVerificado: true,
      notaCuenta: "La asigné a la cuenta Banorte Nómina (terminación 6655) porque la terminación 6655 coincide.",
    });
    expect(msg).toContain("terminación 6655");
  });

  it("lista de selección numerada, sin markdown ni emojis", () => {
    const msg = mensajeSeleccionCuenta(
      [cuenta({ id: "a", numeroCuenta: "0011223344" }), cuenta({ id: "b", banco: "Banorte", nombre: "Nómina", numeroCuenta: "9988776655" })],
      { banco: "BBVA", movimientos: 12 }
    );
    expect(msg).toContain("1) BBVA Cheques (terminación 3344)");
    expect(msg).toContain("2) Banorte Nómina (terminación 6655)");
    expect(msg).toContain('"cancelar"');
    expect(msg).not.toMatch(/[*_#]|[\u{1F300}-\u{1FAFF}]|✅|❌/u);
  });
});

// ── Serialización del payload pendiente (nunca el archivo crudo) ─────────────

describe("serialización de movimientos para pendingAction", () => {
  it("ida y vuelta sin pérdida", () => {
    const originales: ParsedTransaction[] = [
      { fecha: new Date("2026-06-01T12:00:00"), descripcion: "Depósito", monto: 1500.55, referencia: "REF1", saldo: 2000 },
      { fecha: new Date("2026-06-02T12:00:00"), descripcion: "Cargo", monto: -300 },
    ];
    const vuelta = deserializarMovimientos(serializarMovimientos(originales));
    expect(vuelta).toHaveLength(2);
    expect(vuelta[0].fecha.getTime()).toBe(originales[0].fecha.getTime());
    expect(vuelta[0].monto).toBe(1500.55);
    expect(vuelta[0].referencia).toBe("REF1");
    expect(vuelta[1].referencia).toBeUndefined();
    expect(vuelta[1].saldo).toBeUndefined();
  });
});
