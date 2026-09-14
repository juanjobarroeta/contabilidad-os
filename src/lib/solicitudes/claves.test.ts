import { describe, it, expect } from "vitest";
import { etiquetaPeriodo, FICHA_TIPO, redactarPedido, TIPOS_SOLICITUD, tituloDeTipo } from "./claves";

describe("redactarPedido", () => {
  it("dice QUÉ pedir en palabras del cliente, no en jerga contable", () => {
    // «el estado de cuenta de la terminal» no le dice nada a quien nunca lo ha
    // descargado; el reporte que le manda el banco por las ventas con tarjeta sí.
    const p = redactarPedido("estado_cuenta_terminal", { periodo: "2026-07" });
    expect(p).toContain("el reporte mensual que te manda el banco");
    expect(p).toContain("julio de 2026");
  });

  it("siempre dice PARA QUÉ: un pedido sin motivo se ignora", () => {
    for (const t of TIPOS_SOLICITUD) {
      expect(redactarPedido(t)).toContain(FICHA_TIPO[t].paraQue);
    }
  });

  it("el detalle del caso va al final, no en el encabezado", () => {
    const p = redactarPedido("estado_cuenta_terminal", { periodo: "2026-07", detalle: "El banco depositó $30,000.00." });
    expect(p.endsWith("El banco depositó $30,000.00.")).toBe(true);
  });

  it("sin periodo no inventa uno", () => {
    expect(redactarPedido("aclaracion")).not.toMatch(/\bde (enero|febrero|marzo)\b/);
  });
});

describe("etiquetaPeriodo", () => {
  it("traduce el periodo a algo que una persona lee", () => {
    expect(etiquetaPeriodo("2026-09")).toBe("septiembre de 2026");
    expect(etiquetaPeriodo("2026-01")).toBe("enero de 2026");
  });
  it("lo que no tiene forma de periodo se devuelve tal cual, no roto", () => {
    expect(etiquetaPeriodo("2026")).toBe("2026");
    expect(etiquetaPeriodo("2026-13")).toBe("2026-13");
  });
});

describe("tituloDeTipo", () => {
  it("un tipo desconocido se muestra tal cual en vez de desaparecer", () => {
    expect(tituloDeTipo("algo_nuevo")).toBe("algo_nuevo");
    expect(tituloDeTipo("voucher_terminal")).toBe("Vouchers de la terminal");
  });
});
