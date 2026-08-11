import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// El scheduler es la ÚNICA fuente del pipeline desde que se borraron los
// workflows de Actions. Un cron que existe pero no está listado aquí no corre
// nunca: le pasó a sat-vigencia-sync, que se escribió como red de seguridad
// para cancelaciones fuera de la ventana de descarga masiva y estuvo meses sin
// dispararse. Este test fija que siga armado.
//
// Se lee el archivo como texto (JOBS no se exporta y arrancar el módulo
// levantaría timers reales).
// ─────────────────────────────────────────────────────────────────────────────

const fuente = readFileSync(path.join(process.cwd(), "src/lib/cron-scheduler.ts"), "utf8");

describe("cron-scheduler: jobs armados", () => {
  it("incluye la verificación de vigencia por UUID (red de seguridad de cancelaciones)", () => {
    expect(fuente).toMatch(/name:\s*"sat-vigencia-sync"/);
  });

  it("verifica el ejercicio en curso Y el histórico (dos cadencias del mismo cron)", () => {
    const ocurrencias = fuente.match(/name:\s*"sat-vigencia-sync"/g) ?? [];
    expect(ocurrencias.length).toBe(2);
    // El pase histórico arranca en 2015 — antes de eso no hay CFDI 3.3/4.0 útil.
    expect(fuente).toMatch(/desde=2015-01-01/);
  });

  it("mantiene armados los crons de sincronización con el SAT", () => {
    for (const job of ["sat-backfill", "sat-sync", "sat-cancel-sync", "sat-rawxml-backfill"]) {
      expect(fuente).toMatch(new RegExp(`name:\\s*"${job}"`));
    }
  });
});
