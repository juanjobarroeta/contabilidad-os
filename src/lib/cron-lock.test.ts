import { describe, it, expect } from "vitest";
import { cronLockKey } from "./cron-lock";

// Sólo se prueba la lógica PURA (derivación de la clave). withCronLock depende
// de la conexión a Postgres (pg_try_advisory_lock) y se cubre en integración.
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
