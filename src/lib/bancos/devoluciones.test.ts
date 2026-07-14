import { describe, expect, it } from "vitest";
import {
  elegirOrigenDevolucion,
  esDescripcionDevolucion,
  puntuarParDevolucion,
  validarParDevolucion,
  type MovimientoPar,
} from "./devoluciones";

const mov = (o: Partial<MovimientoPar>): MovimientoPar => ({
  id: "x",
  bankAccountId: "cta1",
  fecha: new Date("2026-06-30"),
  monto: 0,
  descripcion: "",
  referencia: null,
  ...o,
});

// El caso real que motivó el feature: SPEI enviado −$22,732.50 conciliado con
// una factura; SPEI DEVUELTO +$22,732.50 el mismo día, misma referencia.
const pagoOriginal = mov({
  id: "orig",
  monto: -22732.5,
  descripcion: "SPEI ENVIADO BAJIO",
  referencia: "0000789161",
});
const devolucion = mov({
  id: "dev",
  monto: 22732.5,
  descripcion: "SPEI DEVUELTO BAJIO",
  referencia: "0000789161",
});

describe("esDescripcionDevolucion", () => {
  it("reconoce las palabras típicas de los bancos", () => {
    for (const d of ["SPEI DEVUELTO BAJIO", "DEVOLUCION SPEI", "PAGO RECHAZADO", "REVERSO TARJETA", "spei devueltobajio"]) {
      expect(esDescripcionDevolucion(d), d).toBe(true);
    }
  });
  it("no marca movimientos normales", () => {
    for (const d of ["SPEI ENVIADO BAJIO", "PAGO FACTURA", "DEPOSITO EFECTIVO", null, undefined, ""]) {
      expect(esDescripcionDevolucion(d), String(d)).toBe(false);
    }
  });
});

describe("validarParDevolucion", () => {
  it("acepta el caso real (montos opuestos, misma cuenta, mismo día)", () => {
    expect(validarParDevolucion(devolucion, pagoOriginal)).toBeNull();
  });

  it("acepta también la dirección inversa (cobro del cliente rebotado)", () => {
    // Cliente pagó +10,000 y el banco lo devolvió −10,000 tres días después.
    const cobro = mov({ id: "c", monto: 10000, fecha: new Date("2026-06-01") });
    const rebote = mov({ id: "r", monto: -10000, fecha: new Date("2026-06-04"), descripcion: "DEVOLUCION SPEI" });
    expect(validarParDevolucion(rebote, cobro)).toBeNull();
  });

  it("rechaza montos que no se netean", () => {
    expect(validarParDevolucion(mov({ id: "d", monto: 22732.5 }), mov({ id: "o", monto: -22732.0 }))).toMatch(/no se netean/);
  });

  it("rechaza cuentas distintas, auto-pares, orden invertido y ventana excedida", () => {
    expect(validarParDevolucion({ ...devolucion, bankAccountId: "cta2" }, pagoOriginal)).toMatch(/misma cuenta/);
    expect(validarParDevolucion(devolucion, { ...devolucion })).toMatch(/propia devolución/);
    expect(
      validarParDevolucion({ ...devolucion, fecha: new Date("2026-06-29") }, pagoOriginal)
    ).toMatch(/anterior al pago/);
    expect(
      validarParDevolucion({ ...devolucion, fecha: new Date("2026-08-15") }, pagoOriginal)
    ).toMatch(/más de 30 días/);
  });
});

describe("puntuarParDevolucion / elegirOrigenDevolucion", () => {
  it("la referencia idéntica + descripción + mismo día puntúan al máximo", () => {
    expect(puntuarParDevolucion(devolucion, pagoOriginal)).toBeCloseTo(4, 5);
  });

  it("elige el original correcto entre varios candidatos del mismo monto", () => {
    const otroMismoMonto = mov({
      id: "otro",
      monto: -22732.5,
      fecha: new Date("2026-06-10"),
      referencia: "0000111111",
    });
    const elegido = elegirOrigenDevolucion(devolucion, [otroMismoMonto, pagoOriginal]);
    expect(elegido?.id).toBe("orig");
  });

  it("sin señal fuerte (score < 2) no propone nada", () => {
    // Devolución sin palabras clave ni referencia coincidente, 20 días después:
    // válido como par manual, pero NO se auto-sugiere.
    const dev = mov({ id: "d", monto: 5000, fecha: new Date("2026-06-25"), descripcion: "SPEI RECIBIDO" });
    const orig = mov({ id: "o", monto: -5000, fecha: new Date("2026-06-05") });
    expect(validarParDevolucion(dev, orig)).toBeNull();
    expect(elegirOrigenDevolucion(dev, [orig])).toBeNull();
  });

  it("candidatos inválidos jamás se eligen aunque coincida la referencia", () => {
    const cuentaAjena = { ...pagoOriginal, bankAccountId: "cta2" };
    expect(elegirOrigenDevolucion(devolucion, [cuentaAjena])).toBeNull();
  });
});
