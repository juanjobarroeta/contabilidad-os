import { describe, it, expect, vi, beforeEach } from "vitest";

const bitacoras: unknown[] = [];
vi.mock("./audit", () => ({
  registrarBitacora: (entrada: unknown) => {
    bitacoras.push(entrada);
  },
}));

import { abrirCredencial, descifrarCerParaVigencia, _resetVentanasParaTests } from "./vault";
import { encryptSecret } from "./crypto";

// Clave de cifrado de prueba (32 bytes base64) — mismo patrón que crypto.test.ts.
process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

type Detalle = { tipo: string; proposito: string; actor: string; campos: string[]; usosAgrupados?: number };
const detalleDe = (i: number) => (bitacoras[i] as { detalle: Detalle }).detalle;

describe("la bóveda (V-1)", () => {
  beforeEach(() => {
    bitacoras.length = 0;
    _resetVentanasParaTests();
  });

  it("descifra y deja bitácora con tipo/propósito/actor/campos — nunca valores", () => {
    const abierto = abrirCredencial({
      companyId: "empresa-1",
      tipo: "fiel",
      proposito: "sat-descarga",
      actor: "cron:sat-sync",
      valores: { cer: encryptSecret("CER-EN-CLARO"), key: encryptSecret("KEY-EN-CLARO") },
    });
    expect(abierto.cer).toBe("CER-EN-CLARO");
    expect(abierto.key).toBe("KEY-EN-CLARO");

    expect(bitacoras).toHaveLength(1);
    const d = detalleDe(0);
    expect(d).toMatchObject({
      tipo: "fiel",
      proposito: "sat-descarga",
      actor: "cron:sat-sync",
      campos: ["cer", "key"],
    });
    expect(JSON.stringify(bitacoras[0])).not.toContain("EN-CLARO");
  });

  it("propósito fuera de la allowlist del tipo: lanza sin descifrar", () => {
    expect(() =>
      abrirCredencial({
        companyId: "empresa-1",
        tipo: "csd",
        // @ts-expect-error — propósito de fiel, no de csd; el tipo YA lo impide
        proposito: "sat-descarga",
        valores: { cer: encryptSecret("x") },
      })
    ).toThrow(/no permitido/);
    expect(bitacoras).toHaveLength(0);
  });

  it("campo vacío: lanza en vez de fingir que había credencial", () => {
    expect(() =>
      abrirCredencial({
        companyId: "empresa-1",
        tipo: "fiel",
        proposito: "sat-descarga",
        valores: { cer: "" },
      })
    ).toThrow(/vacío/);
    expect(bitacoras).toHaveLength(0);
  });

  it("los usos de llave privada se registran uno a uno (sin agrupación)", () => {
    for (let i = 0; i < 3; i++) {
      abrirCredencial({
        companyId: "empresa-1",
        tipo: "csd",
        proposito: "facturapi-upload",
        valores: { key: encryptSecret("k") },
      });
    }
    expect(bitacoras).toHaveLength(3);
  });

  it("pac-call se agrupa por ventana y reporta usosAgrupados en la siguiente fila", () => {
    vi.useFakeTimers();
    try {
      const abrir = () =>
        abrirCredencial({
          companyId: "empresa-1",
          tipo: "facturapi-key",
          proposito: "pac-call",
          valores: { apiKey: encryptSecret("sk") },
        });

      abrir(); // fila 1 (abre ventana)
      abrir();
      abrir(); // agrupados: 2
      expect(bitacoras).toHaveLength(1);

      vi.advanceTimersByTime(61 * 60_000);
      abrir(); // fila 2, con usosAgrupados=2
      expect(bitacoras).toHaveLength(2);
      expect(detalleDe(1).usosAgrupados).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ventanas independientes por empresa: el uso de una no silencia a la otra", () => {
    const abrir = (companyId: string) =>
      abrirCredencial({
        companyId,
        tipo: "facturapi-key",
        proposito: "pac-call",
        valores: { apiKey: encryptSecret("sk") },
      });
    abrir("empresa-1");
    abrir("empresa-2");
    expect(bitacoras).toHaveLength(2);
  });

  it("descifrarCerParaVigencia: sin bitácora (certificado público, corre en listados)", () => {
    expect(descifrarCerParaVigencia(encryptSecret("CER"))).toBe("CER");
    expect(bitacoras).toHaveLength(0);
  });
});
