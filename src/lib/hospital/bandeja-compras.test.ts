import { describe, expect, it } from "vitest";
import { estadoLinea, urgenciaEfectiva, urgenciaPorExistencia } from "./bandeja-compras";

describe("urgencia de la bandeja", () => {
  it("el inventario manda: sin existencia urgente, bajo mínimo semiurgente", () => {
    expect(urgenciaPorExistencia(0, 10)).toBe("URGENTE");
    expect(urgenciaPorExistencia(4, 10)).toBe("SEMIURGENTE");
    expect(urgenciaPorExistencia(10, 10)).toBe("NORMAL");
    expect(urgenciaPorExistencia(3, 0)).toBe("NORMAL");
    expect(urgenciaPorExistencia(null, null)).toBeNull();
  });
  it("se toma la mayor entre la del área y la del inventario", () => {
    expect(urgenciaEfectiva("NORMAL", "URGENTE")).toBe("URGENTE");
    expect(urgenciaEfectiva("URGENTE", "NORMAL")).toBe("URGENTE");
    expect(urgenciaEfectiva("SEMIURGENTE", null)).toBe("SEMIURGENTE");
  });
});

describe("estado de la línea", () => {
  const req = (estado: string, enviado = false) => ({ estado, pedidoEnviadoAt: enviado ? new Date() : null });
  it("sin requisición o cancelada: en la bandeja", () => {
    expect(estadoLinea({ cierre: null, requisicion: null, partida: null })).toBe("EN_BANDEJA");
    expect(estadoLinea({ cierre: null, requisicion: req("CANCELADA"), partida: null })).toBe("EN_BANDEJA");
  });
  it("sigue a la requisición: por autorizar, rechazada, por enviar, pedida", () => {
    expect(estadoLinea({ cierre: null, requisicion: req("PENDIENTE"), partida: { cantidad: 5, recibida: 0 } })).toBe("POR_AUTORIZAR");
    expect(estadoLinea({ cierre: null, requisicion: req("RECHAZADA"), partida: { cantidad: 5, recibida: 0 } })).toBe("RECHAZADA");
    expect(estadoLinea({ cierre: null, requisicion: req("APROBADA"), partida: { cantidad: 5, recibida: 0 } })).toBe("POR_ENVIAR");
    expect(estadoLinea({ cierre: null, requisicion: req("APROBADA", true), partida: { cantidad: 5, recibida: 0 } })).toBe("PEDIDA");
  });
  it("lo recibido: parcial o recibida", () => {
    expect(estadoLinea({ cierre: null, requisicion: req("APROBADA", true), partida: { cantidad: 5, recibida: 2 } })).toBe("PARCIAL");
    expect(estadoLinea({ cierre: null, requisicion: req("PAGADA", true), partida: { cantidad: 5, recibida: 5 } })).toBe("RECIBIDA");
  });
  it("el cierre manda", () => {
    expect(estadoLinea({ cierre: "DESABASTO", requisicion: null, partida: null })).toBe("DESABASTO");
  });
});
