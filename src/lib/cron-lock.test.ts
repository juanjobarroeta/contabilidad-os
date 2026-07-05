import { describe, it, expect } from "vitest";
import { cronLockKey, esCorridaVigente, TTL_CORRIDA_MS } from "./cron-lock";

// Sólo se prueba la lógica PURA (derivación de la clave y decisión de
// toma/takeover). withCronLock depende de la conexión a Postgres y del mutex de
// fila (CronLock), y se cubre en integración.
describe("cronLockKey", () => {
  it("es determinista: la misma entrada produce la misma clave", () => {
    expect(cronLockKey("sat-sync")).toBe(cronLockKey("sat-sync"));
  });

  it("antepone el prefijo cron: cuando falta", () => {
    expect(cronLockKey("sat-sync")).toBe("cron:sat-sync");
  });

  it("no duplica el prefijo cron: cuando ya viene", () => {
    expect(cronLockKey("cron:sat-sync")).toBe("cron:sat-sync");
  });

  it("normaliza mayúsculas y espacios al mismo candado", () => {
    const canonica = "cron:sat-sync";
    expect(cronLockKey("SAT-SYNC")).toBe(canonica);
    expect(cronLockKey("  sat-sync  ")).toBe(canonica);
    expect(cronLockKey("Cron:SAT-Sync")).toBe(canonica);
  });

  it("distingue trabajos diferentes en claves diferentes", () => {
    expect(cronLockKey("sat-sync")).not.toBe(cronLockKey("sat-cancel-sync"));
    expect(cronLockKey("auto-conciliar")).not.toBe(cronLockKey("sat-backfill"));
  });

  it("mantiene claves estables conocidas (cambiarlas soltaría el solapamiento)", () => {
    expect(cronLockKey("sat-sync")).toBe("cron:sat-sync");
    expect(cronLockKey("sat-cancel-sync")).toBe("cron:sat-cancel-sync");
    expect(cronLockKey("auto-conciliar")).toBe("cron:auto-conciliar");
  });

  it("rechaza un nombre de trabajo vacío", () => {
    expect(() => cronLockKey("")).toThrow();
    expect(() => cronLockKey("   ")).toThrow();
  });
});

describe("esCorridaVigente", () => {
  const now = new Date("2026-07-05T12:00:00.000Z");

  it("una corrida fresca (dentro del TTL) está vigente → se omite (409)", () => {
    const hace1min = new Date(now.getTime() - 60 * 1000);
    expect(esCorridaVigente(hace1min, now)).toBe(true);
  });

  it("una corrida vencida (más vieja que el TTL) NO está vigente → takeover", () => {
    const hace11min = new Date(now.getTime() - (TTL_CORRIDA_MS + 60 * 1000));
    expect(esCorridaVigente(hace11min, now)).toBe(false);
  });

  it("un candado liberado (fecha epoch) NO está vigente → tomable", () => {
    expect(esCorridaVigente(new Date(0), now)).toBe(false);
  });

  it("en el límite exacto del TTL ya NO está vigente (takeover)", () => {
    const justoEnElTtl = new Date(now.getTime() - TTL_CORRIDA_MS);
    expect(esCorridaVigente(justoEnElTtl, now)).toBe(false);
  });

  it("respeta un ttlMs explícito", () => {
    const hace5s = new Date(now.getTime() - 5000);
    expect(esCorridaVigente(hace5s, now, 10_000)).toBe(true);
    expect(esCorridaVigente(hace5s, now, 1_000)).toBe(false);
  });
});
