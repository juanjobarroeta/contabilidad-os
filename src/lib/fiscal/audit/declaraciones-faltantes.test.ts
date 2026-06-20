import { describe, it, expect } from "vitest";
import { auditarDeclaracionesFaltantes } from "./declaraciones-faltantes";
import type { AcuseFaltante } from "@/lib/fiscal/cobertura-declaraciones";

const f = (tipo: AcuseFaltante["tipo"], periodo: string, etiqueta: string, critico = true): AcuseFaltante => ({
  companyId: "c1", tipo, periodo, etiqueta, motivo: "x", critico,
});

describe("auditarDeclaracionesFaltantes", () => {
  it("no emite hallazgo cuando no falta nada", () => {
    expect(auditarDeclaracionesFaltantes([])).toEqual([]);
  });

  it("ignora faltantes no críticos (anuales históricas) — no dispara la alarma", () => {
    const out = auditarDeclaracionesFaltantes([
      f("DECLARACION_ANUAL", "2021", "Declaración anual 2021", false),
      f("DECLARACION_ANUAL", "2022", "Declaración anual 2022", false),
    ]);
    expect(out).toEqual([]);
  });

  it("emite un hallazgo sólo con los críticos, referencias estables por tipo:periodo", () => {
    const out = auditarDeclaracionesFaltantes([
      f("DECLARACION_ANUAL", "2022", "Declaración anual 2022", false), // histórico → ignorado
      f("DECLARACION_ANUAL", "2025", "Declaración anual 2025"),
      f("IVA_MENSUAL", "2026-03", "IVA marzo 2026"),
    ]);
    expect(out).toHaveLength(1);
    const h = out[0];
    expect(h.checkClave).toBe("declaraciones.faltantes");
    expect(h.severidad).toBe("warn");
    expect(h.referencias).toEqual(["DECLARACION_ANUAL:2025", "IVA_MENSUAL:2026-03"]);
    expect(h.mensaje).toContain("2 declaración");
    expect(h.mensaje.toLowerCase()).toContain("arrastre");
    expect(h.sugerencia).toContain("Declaración anual 2025");
  });
});
