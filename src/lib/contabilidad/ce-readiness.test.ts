import { describe, it, expect } from "vitest";
import {
  evaluarChecks,
  regimenRequiereBalance,
  type ReadinessInputs,
} from "./ce-readiness";

// ─────────────────────────────────────────────────────────────────────────────
// Tests de la PUNTUACIÓN PURA (evaluarChecks). Sin DB: dado un conjunto de
// hechos del periodo, comprueban el estado global correcto y el estado de cada
// check. El camino con DB (evaluarReadinessCE) sólo arma estos hechos a partir
// de balanza()/conteos y delega aquí, así que probar esta capa cubre la lógica.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-29T00:00:00Z");

// Empresa moral sana: CFDIs frescos, banco completo y clasificado, cuadra,
// mes cerrado.
function base(): ReadinessInputs {
  return {
    cfdiCount: 12,
    cuentasSinAgrupador: 0,
    lastSyncAt: new Date("2026-06-28T00:00:00Z"),
    now: NOW,
    bankTxCount: 30,
    bankUnmatchedCount: 0,
    totalCargos: 100000,
    totalAbonos: 100000,
    posted: true,
    requiereBalance: true,
    esEmpresaNueva: false,
  };
}

const find = (r: ReturnType<typeof evaluarChecks>, clave: string) =>
  r.checks.find((c) => c.clave === clave);

describe("regimenRequiereBalance", () => {
  it("persona moral (601) requiere balance", () => {
    expect(regimenRequiereBalance("601")).toBe(true);
  });
  it("RESICO PF (626) no requiere balance", () => {
    expect(regimenRequiereBalance("626")).toBe(false);
  });
  it("ignora espacios", () => {
    expect(regimenRequiereBalance(" 601 ")).toBe(true);
  });
});

describe("evaluarChecks — estado global", () => {
  it("todo ok → lista", () => {
    const r = evaluarChecks(base());
    expect(r.status).toBe("lista");
    expect(r.checks.every((c) => c.estado === "ok")).toBe(true);
    expect(r.resumen).toMatch(/Lista para el SAT/);
  });

  it("sólo warns → con_huecos", () => {
    const r = evaluarChecks({ ...base(), bankUnmatchedCount: 3, posted: false });
    expect(r.status).toBe("con_huecos");
    expect(r.checks.some((c) => c.estado === "error")).toBe(false);
    expect(r.checks.some((c) => c.estado === "warn")).toBe(true);
  });

  it("cualquier error → incompleta", () => {
    const r = evaluarChecks({ ...base(), bankTxCount: 0, bankUnmatchedCount: 0 });
    expect(r.status).toBe("incompleta");
  });
});

describe("evaluarChecks — CFDIs", () => {
  it("sin CFDIs → error", () => {
    const r = evaluarChecks({ ...base(), cfdiCount: 0 });
    expect(find(r, "cfdis")?.estado).toBe("error");
    expect(r.status).toBe("incompleta");
  });

  it("sync viejo (>7 días) → warn", () => {
    const r = evaluarChecks({
      ...base(),
      lastSyncAt: new Date("2026-06-01T00:00:00Z"),
    });
    expect(find(r, "cfdis")?.estado).toBe("warn");
  });

  it("sync nunca hecho pero hay CFDIs → ok (no podemos medir antigüedad)", () => {
    const r = evaluarChecks({ ...base(), lastSyncAt: null });
    expect(find(r, "cfdis")?.estado).toBe("ok");
  });
});

describe("evaluarChecks — banco (fuente-agnóstico)", () => {
  it("régimen con balance sin banco → error con CTA accionable", () => {
    const r = evaluarChecks({ ...base(), bankTxCount: 0, bankUnmatchedCount: 0 });
    const banco = find(r, "banco");
    expect(banco?.estado).toBe("error");
    expect(banco?.detalle).toMatch(/balance no cierra/);
    // Importar el estado de cuenta vive en el tab Cuentas de /bancos.
    expect(banco?.cta?.href).toBe("/bancos?tab=cuentas");
  });

  it("régimen sin balance sin banco → warn (no bloquea)", () => {
    const r = evaluarChecks({
      ...base(),
      requiereBalance: false,
      bankTxCount: 0,
      bankUnmatchedCount: 0,
    });
    expect(find(r, "banco")?.estado).toBe("warn");
    expect(r.status).not.toBe("incompleta");
  });

  it("hay banco → ok, sin importar la fuente", () => {
    const r = evaluarChecks({ ...base(), bankTxCount: 5 });
    expect(find(r, "banco")?.estado).toBe("ok");
  });
});

describe("evaluarChecks — sin clasificar", () => {
  it("movimientos sin conciliar → warn con conteo y CTA a Bancos", () => {
    const r = evaluarChecks({ ...base(), bankUnmatchedCount: 4 });
    const c = find(r, "sin_clasificar");
    expect(c?.estado).toBe("warn");
    expect(c?.titulo).toMatch(/4 movimiento/);
    // El triage (conciliar/categorizar) vive en el tab Movimientos.
    expect(c?.cta?.href).toBe("/bancos?tab=movimientos");
  });

  it("sin banco → el check no aplica", () => {
    const r = evaluarChecks({ ...base(), bankTxCount: 0, requiereBalance: false });
    expect(find(r, "sin_clasificar")).toBeUndefined();
  });
});

describe("evaluarChecks — cuadre", () => {
  it("descuadre > tolerancia → error", () => {
    const r = evaluarChecks({ ...base(), totalCargos: 100000, totalAbonos: 99000 });
    expect(find(r, "cuadre")?.estado).toBe("error");
    expect(r.status).toBe("incompleta");
  });

  it("diferencia dentro de tolerancia (1 centavo) → ok", () => {
    const r = evaluarChecks({ ...base(), totalCargos: 100000.0, totalAbonos: 99999.995 });
    expect(find(r, "cuadre")?.estado).toBe("ok");
  });
});

describe("evaluarChecks — posteo", () => {
  it("DRAFT → warn preliminar", () => {
    const r = evaluarChecks({ ...base(), posted: false });
    expect(find(r, "posteo")?.estado).toBe("warn");
    expect(find(r, "posteo")?.detalle).toMatch(/bloqueada|preliminar|cerrado/i);
  });

  it("posteado → ok", () => {
    const r = evaluarChecks({ ...base(), posted: true });
    expect(find(r, "posteo")?.estado).toBe("ok");
  });
});

describe("evaluarChecks — capital inicial (opcional)", () => {
  it("empresa nueva sin capital → warn", () => {
    const r = evaluarChecks({
      ...base(),
      esEmpresaNueva: true,
      tieneCapitalInicial: false,
    });
    expect(find(r, "capital_inicial")?.estado).toBe("warn");
  });

  it("empresa nueva con capital → check omitido", () => {
    const r = evaluarChecks({
      ...base(),
      esEmpresaNueva: true,
      tieneCapitalInicial: true,
    });
    expect(find(r, "capital_inicial")).toBeUndefined();
  });

  it("dato indeterminado (undefined) → check omitido", () => {
    const r = evaluarChecks({ ...base(), esEmpresaNueva: true });
    expect(find(r, "capital_inicial")).toBeUndefined();
  });

  it("empresa no nueva → check omitido aunque falte capital", () => {
    const r = evaluarChecks({
      ...base(),
      esEmpresaNueva: false,
      tieneCapitalInicial: false,
    });
    expect(find(r, "capital_inicial")).toBeUndefined();
  });
});

describe("check de códigos agrupadores (planes propios sin mapear)", () => {
  it("con cuentas sin agrupador válido: error con conteo y CTA al catálogo", () => {
    const r = evaluarChecks({ ...base(), cuentasSinAgrupador: 39 });
    const c = find(r, "agrupadores");
    expect(c?.estado).toBe("error");
    expect(c?.titulo).toContain("39 cuentas");
    expect(c?.cta?.href).toBe("/contabilidad/catalogo");
    expect(r.status).toBe("incompleta");
  });

  it("singular sin «(s)»", () => {
    const c = find(evaluarChecks({ ...base(), cuentasSinAgrupador: 1 }), "agrupadores");
    expect(c?.titulo).toBe("1 cuenta sin código agrupador del SAT");
  });

  it("catálogo completo: el check ni aparece (en semilla sería ruido)", () => {
    expect(find(evaluarChecks(base()), "agrupadores")).toBeUndefined();
  });
});
