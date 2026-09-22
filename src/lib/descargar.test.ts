import { describe, it, expect, afterEach } from "vitest";
import { sinGestorDeDescargas } from "./descargar";

// ─────────────────────────────────────────────────────────────────────────────
// Quién se lleva la HOJA DE COMPARTIR y quién la descarga de siempre.
//
// El bug: el owner pidió el PDF de un CFDI en Facturas desde su Mac y le salió
// la tarjeta de compartir de macOS. La condición era sólo «standalone», y macOS
// instala la app igual que iOS —pero sí tiene gestor de descargas—, así que la
// hoja estorbaba donde el ancla funciona perfecto.
// ─────────────────────────────────────────────────────────────────────────────

const UA = {
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  iPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  iPadViejo:
    "Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Mobile/15E148 Safari/604.1",
  // iPadOS 13+ miente y dice «Macintosh»; sólo el multitáctil lo delata.
  iPadModerno:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

function fingirNavegador(userAgent: string, maxTouchPoints = 0) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent, maxTouchPoints },
    configurable: true,
    writable: true,
  });
}

const navegadorOriginal = Object.getOwnPropertyDescriptor(globalThis, "navigator");
afterEach(() => {
  if (navegadorOriginal) Object.defineProperty(globalThis, "navigator", navegadorOriginal);
});

describe("sinGestorDeDescargas", () => {
  it("(a) un Mac NO se lleva la hoja de compartir — es el bug reportado", () => {
    fingirNavegador(UA.macSafari, 0);
    expect(sinGestorDeDescargas()).toBe(false);
  });

  it("(b) iPhone e iPad viejo sí: ahí <a download> no opera", () => {
    fingirNavegador(UA.iPhone);
    expect(sinGestorDeDescargas()).toBe(true);
    fingirNavegador(UA.iPadViejo);
    expect(sinGestorDeDescargas()).toBe(true);
  });

  it("(c) iPadOS 13+ se disfraza de Macintosh; el multitáctil lo delata", () => {
    fingirNavegador(UA.iPadModerno, 5);
    expect(sinGestorDeDescargas()).toBe(true);
  });

  it("(d) Android y Windows descargan normal", () => {
    fingirNavegador(UA.androidChrome, 5);
    expect(sinGestorDeDescargas()).toBe(false);
    fingirNavegador(UA.windows, 0);
    expect(sinGestorDeDescargas()).toBe(false);
  });

  it("(e) un Mac con pantalla táctil externa sigue descargando normal", () => {
    // maxTouchPoints 1 no es un iPad; el umbral es > 1.
    fingirNavegador(UA.macSafari, 1);
    expect(sinGestorDeDescargas()).toBe(false);
  });

  it("(f) sin navigator (servidor) no truena", () => {
    Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true, writable: true });
    expect(sinGestorDeDescargas()).toBe(false);
  });
});
