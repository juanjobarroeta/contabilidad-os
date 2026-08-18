import { describe, it, expect } from "vitest";
import { resumirCierre } from "./cierre-resumen";
import {
  evaluarChecks,
  type ReadinessCheck,
  type ReadinessInputs,
  type ReadinessResult,
} from "./ce-readiness";

// Empresa moral sana, igual que en ce-readiness.test.ts: sirve para comprobar
// el resumen sobre una evaluación REAL y no sólo sobre checks fabricados.
function base(): ReadinessInputs {
  return {
    cfdiCount: 12,
    lastSyncAt: new Date("2026-06-28T00:00:00Z"),
    now: new Date("2026-06-29T00:00:00Z"),
    bankTxCount: 30,
    bankUnmatchedCount: 0,
    totalCargos: 100000,
    totalAbonos: 100000,
    posted: true,
    requiereBalance: true,
    esEmpresaNueva: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// resumirCierre — lo que consume la tarjeta "Pendientes del cierre".
// ─────────────────────────────────────────────────────────────────────────────

function check(clave: string, estado: ReadinessCheck["estado"]): ReadinessCheck {
  return { clave, estado, titulo: clave, detalle: "" };
}

function resultado(...checks: ReadinessCheck[]): ReadinessResult {
  return { status: "con_huecos", resumen: "", checks };
}

describe("resumirCierre", () => {
  it("cuenta los listos y deja fuera de pendientes lo que ya está en verde", () => {
    const r = resumirCierre(
      resultado(check("cfdis", "ok"), check("banco", "ok"), check("cuadre", "warn"))
    );
    expect(r.total).toBe(3);
    expect(r.listos).toBe(2);
    expect(r.pendientes.map((c) => c.clave)).toEqual(["cuadre"]);
  });

  it("los errores van al frente: bloquean el cierre, los warns sólo lo ensucian", () => {
    const r = resumirCierre(
      resultado(
        check("sin_clasificar", "warn"),
        check("cuadre", "error"),
        check("posteo", "warn"),
        check("cfdis", "error")
      )
    );
    expect(r.pendientes.map((c) => c.clave)).toEqual([
      "cuadre",
      "cfdis",
      "sin_clasificar",
      "posteo",
    ]);
    expect(r.bloqueantes).toBe(2);
  });

  it("dentro del mismo estado conserva el orden del flujo del mes", () => {
    const r = resumirCierre(
      resultado(check("cfdis", "warn"), check("banco", "warn"), check("posteo", "warn"))
    );
    expect(r.pendientes.map((c) => c.clave)).toEqual(["cfdis", "banco", "posteo"]);
  });

  it("todo en verde → todoListo, sin pendientes ni bloqueantes", () => {
    const r = resumirCierre(resultado(check("cfdis", "ok"), check("cuadre", "ok")));
    expect(r.todoListo).toBe(true);
    expect(r.pendientes).toEqual([]);
    expect(r.bloqueantes).toBe(0);
    expect(r.listos).toBe(2);
  });

  it("con un solo warn NO está todo listo (el progreso no basta para cerrar)", () => {
    const r = resumirCierre(resultado(check("cfdis", "ok"), check("posteo", "warn")));
    expect(r.todoListo).toBe(false);
    expect(r.bloqueantes).toBe(0);
  });

  it("sobre una evaluación real: el mes preliminar queda como pendiente", () => {
    const real = evaluarChecks({ ...base(), posted: false });
    const r = resumirCierre(real);
    expect(r.total).toBe(real.checks.length);
    expect(r.pendientes.some((c) => c.clave === "posteo")).toBe(true);
    expect(r.todoListo).toBe(false);
  });
});
