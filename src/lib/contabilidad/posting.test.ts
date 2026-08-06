import { describe, it, expect } from "vitest";
import { REGENERATED_SOURCES, simulateRepost, summarizeEntries } from "./posting";
import type { EntrySource, EntryType } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Estos tests cubren la lógica PURA del re-posteo no destructivo de postMonth():
// qué asientos se borran y cuáles se preservan, y cómo se recalculan los totales
// del periodo sobre TODOS los asientos que quedan.
//
// La función postMonth() en sí está fuertemente acoplada a Prisma (lee CFDIs,
// bancos y nómina y escribe en una transacción), por lo que el flujo completo se
// verifica a mano contra la base. Pero el invariante crítico — "un re-posteo
// conserva los asientos MANUAL/APERTURA/satélite y sólo refresca CFDI/NOMINA/
// BANCO" — está aislado en simulateRepost/REGENERATED_SOURCES y se prueba aquí.
//
// Verificación manual del camino DB (no automatizable sin DB):
//   1. Postear un mes con CFDIs  → genera asientos CFDI.
//   2. Capturar un asiento MANUAL (ajuste del contador) en ese mes.
//   3. Re-postear el mes (postMonth o post-pending) tras corregir un CFDI.
//   4. Comprobar que el asiento MANUAL SIGUE existiendo y que los CFDI se
//      regeneraron; entriesCount/totalCargos/totalAbonos del periodo incluyen
//      el MANUAL.
// ─────────────────────────────────────────────────────────────────────────────

type E = { fuente: EntrySource; tipo: EntryType; monto: number; id: string };

const e = (id: string, fuente: EntrySource, tipo: EntryType, monto: number): E => ({
  id,
  fuente,
  tipo,
  monto,
});

describe("REGENERATED_SOURCES", () => {
  it("contiene exactamente las fuentes que postMonth regenera", () => {
    expect([...REGENERATED_SOURCES].sort()).toEqual(["BANCO", "CFDI", "DEPRECIACION", "NOMINA"]);
  });

  it("NO incluye fuentes que se preservan (MANUAL, APERTURA, CIERRE, satélite)", () => {
    const preserved: EntrySource[] = [
      "MANUAL",
      "APERTURA",
      "CIERRE",
      "CONSTRUCCION",
      "FLOTA",
      "PADEL",
    ];
    for (const f of preserved) {
      expect(REGENERATED_SOURCES).not.toContain(f);
    }
  });
});

describe("simulateRepost — re-posteo no destructivo", () => {
  it("conserva el asiento MANUAL y refresca los CFDI", () => {
    const existing: E[] = [
      e("cfdi-old-1", "CFDI", "CARGO", 1000),
      e("cfdi-old-2", "CFDI", "ABONO", 1000),
      e("manual-1", "MANUAL", "CARGO", 500),
      e("manual-2", "MANUAL", "ABONO", 500),
    ];
    // El motor vuelve a generar SÓLO los CFDI (con montos corregidos).
    const regenerated: E[] = [
      e("cfdi-new-1", "CFDI", "CARGO", 1200),
      e("cfdi-new-2", "CFDI", "ABONO", 1200),
    ];

    const after = simulateRepost(existing, regenerated);
    const ids = after.map((x) => x.id).sort();

    // Los MANUAL sobreviven; los CFDI viejos desaparecen y entran los nuevos.
    expect(ids).toEqual(["cfdi-new-1", "cfdi-new-2", "manual-1", "manual-2"]);
    expect(after.some((x) => x.id === "cfdi-old-1")).toBe(false);
    expect(after.filter((x) => x.fuente === "MANUAL")).toHaveLength(2);
  });

  it("preserva APERTURA, CIERRE y fuentes satélite (CONSTRUCCION/FLOTA/PADEL)", () => {
    const existing: E[] = [
      e("ap", "APERTURA", "CARGO", 100),
      e("ci", "CIERRE", "ABONO", 100),
      e("co", "CONSTRUCCION", "CARGO", 10),
      e("fl", "FLOTA", "ABONO", 20),
      e("pa", "PADEL", "CARGO", 30),
      e("cfdi", "CFDI", "ABONO", 40),
    ];
    const after = simulateRepost(existing, []);
    expect(after.map((x) => x.id).sort()).toEqual(["ap", "ci", "co", "fl", "pa"]);
    // El CFDI se borró aunque no haya nada que regenerar.
    expect(after.some((x) => x.fuente === "CFDI")).toBe(false);
  });
});

describe("summarizeEntries — totales del periodo sobre TODOS los asientos", () => {
  it("incluye los asientos preservados (MANUAL) en cargos/abonos/conteo", () => {
    // Estado tras un re-posteo: CFDI nuevos + MANUAL preservado.
    const entries: E[] = [
      e("cfdi-1", "CFDI", "CARGO", 1200),
      e("cfdi-2", "CFDI", "ABONO", 1200),
      e("manual-1", "MANUAL", "CARGO", 500),
      e("manual-2", "MANUAL", "ABONO", 500),
    ];
    const s = summarizeEntries(entries);
    expect(s.entriesCount).toBe(4); // no sólo los 2 CFDI insertados
    expect(s.totalCargos).toBe(1700); // 1200 CFDI + 500 MANUAL
    expect(s.totalAbonos).toBe(1700);
  });

  it("compone con simulateRepost: el total final cuenta el MANUAL preservado", () => {
    const existing: E[] = [
      e("cfdi-old", "CFDI", "CARGO", 1000),
      e("cfdi-old2", "CFDI", "ABONO", 1000),
      e("manual", "MANUAL", "CARGO", 500),
      e("manual2", "MANUAL", "ABONO", 500),
    ];
    const regenerated: E[] = [
      e("cfdi-new", "CFDI", "CARGO", 1200),
      e("cfdi-new2", "CFDI", "ABONO", 1200),
    ];
    const s = summarizeEntries(simulateRepost(existing, regenerated));
    expect(s.entriesCount).toBe(4);
    expect(s.totalCargos).toBe(1700);
    expect(s.totalAbonos).toBe(1700);
  });
});
