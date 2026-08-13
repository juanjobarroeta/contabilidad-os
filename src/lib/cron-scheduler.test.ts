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

// ─────────────────────────────────────────────────────────────────────────────
// Ritmo adaptativo: la aceleración por pendientes sólo es segura si TODO
// trabajo que toca al SAT (o que cuesta dinero) declara un piso alto. Un job
// sin piso caería en MIN_LOCAL (10 s) y podría atropellar una cuota externa.
// ─────────────────────────────────────────────────────────────────────────────

describe("cron-scheduler: pisos del ritmo adaptativo", () => {
  /** Bloque de cada job del arreglo JOBS, para inspeccionar sus campos. */
  const bloques = [...fuente.matchAll(/\{[^{}]*name:\s*"([a-z0-9-]+)"[^{}]*\}/g)].map((m) => ({
    name: m[1],
    texto: m[0],
  }));

  it("todo cron que habla con el SAT declara piso de SAT (o mayor)", () => {
    const delSat = bloques.filter((b) => b.name.startsWith("sat-"));
    expect(delSat.length).toBeGreaterThanOrEqual(5);
    for (const b of delSat) {
      expect(b.texto, `${b.name} sin piso de SAT`).toMatch(/minMs:\s*MIN_SAT/);
    }
  });

  it("los crons que cuestan dinero llevan el piso caro", () => {
    for (const name of ["compliance-provision", "compliance-sync", "declaraciones-backfill"]) {
      const b = bloques.find((x) => x.name === name);
      expect(b, `falta el job ${name}`).toBeDefined();
      expect(b!.texto, `${name} sin piso caro`).toMatch(/minMs:\s*MIN_CARO/);
    }
  });

  it("el bucle se reprograma tras terminar (no setInterval, que se solaparía)", () => {
    expect(fuente).toMatch(/correrEnBucle/);
    // Sin LLAMADAS a setInterval (las menciones en comentarios no cuentan).
    expect(fuente).not.toMatch(/setInterval\s*\(/);
  });

  it("el encadenamiento por evento existe y arranca en la descarga del SAT", () => {
    const backfill = bloques.find((b) => b.name === "sat-backfill");
    expect(backfill!.texto).toMatch(/encadena:/);
  });
});
