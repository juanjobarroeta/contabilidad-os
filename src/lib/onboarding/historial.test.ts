import { describe, expect, it } from "vitest";
import {
  cifraCorta,
  estadoDeMes,
  mesesHistorial,
  narrar,
  rangoMeses,
  resumirHistorial,
  satDijoPorMes,
  type MesHistorial,
  type SolicitudMes,
} from "./historial";
import { mezclarProgreso, PROGRESO_INICIAL, sanearProgreso, tonoSugerido } from "./progreso";
import { LINEAS, esc, t } from "./lineas";
import { PASOS_RECORRIDO } from "./recorrido";

const HOY = new Date(Date.UTC(2026, 9, 1)); // 1-oct-2026

function sol(y: number, m: number, tipo: string, status: string, extra: Partial<SolicitudMes> = {}): SolicitudMes {
  return { year: y, month: m, tipo, status, cfdisFound: 0, errorMessage: null, desde: null, hasta: null, createdAt: "2026-10-01T00:00:00Z", ...extra };
}

describe("historial: rango", () => {
  it("cuenta hacia atrás desde el mes actual, como sat-backfill", () => {
    const r = rangoMeses(HOY, 1, null);
    expect(r).toHaveLength(12);
    expect(r[0]).toEqual({ y: 2026, m: 10 });
    expect(r[11]).toEqual({ y: 2025, m: 11 });
  });
  it("se corta en el inicio de operaciones", () => {
    const r = rangoMeses(HOY, 5, new Date(Date.UTC(2026, 6, 15)));
    expect(r.map((x) => x.m)).toEqual([10, 9, 8, 7]);
  });
});

describe("historial: estado de un mes", () => {
  it("ok con emitidos y recibidos terminados", () => {
    expect(estadoDeMes([sol(2026, 9, "EMITIDOS", "FINISHED"), sol(2026, 9, "RECIBIDOS", "FINISHED")], 100, 100)).toBe("ok");
  });
  it("hueco si el SAT dijo que había y no llegaron", () => {
    expect(estadoDeMes([sol(2026, 9, "EMITIDOS", "FINISHED"), sol(2026, 9, "RECIBIDOS", "FINISHED")], 800, 3)).toBe("hole");
  });
  it("en vuelo, cuota 5002, error y pendiente", () => {
    expect(estadoDeMes([sol(2026, 9, "EMITIDOS", "IN_PROGRESS")], 0, 0)).toBe("req");
    expect(estadoDeMes([sol(2026, 9, "EMITIDOS", "FAILED", { errorMessage: "5002 límite" })], 0, 0)).toBe("quota");
    expect(estadoDeMes([sol(2026, 9, "EMITIDOS", "EXPIRED")], 0, 0)).toBe("error");
    expect(estadoDeMes([], 0, 0)).toBe("pendiente");
    // Sólo un tipo listo: falta pedir el otro.
    expect(estadoDeMes([sol(2026, 9, "EMITIDOS", "FINISHED")], 0, 0)).toBe("pendiente");
  });
  it("las consultas de metadata no cuentan como descarga", () => {
    expect(estadoDeMes([sol(2026, 9, "METADATA_EMITIDOS", "IN_PROGRESS")], 0, 0)).toBe("pendiente");
  });
});

describe("historial: lo que dijo el SAT", () => {
  it("si el mes se pidió en tramos, sólo suman los tramos", () => {
    const m = satDijoPorMes([
      sol(2026, 8, "EMITIDOS", "FINISHED", { cfdisFound: 500 }),
      sol(2026, 8, "EMITIDOS", "FINISHED", { cfdisFound: 200, desde: "2026-08-01", hasta: "2026-08-15" }),
      sol(2026, 8, "EMITIDOS", "FINISHED", { cfdisFound: 310, desde: "2026-08-16", hasta: "2026-08-31" }),
      sol(2026, 8, "RECIBIDOS", "FINISHED", { cfdisFound: 40 }),
    ]);
    expect(m.get("2026-8")).toBe(550);
  });
  it("una fila repetida del mismo rango cuenta una vez (la más reciente)", () => {
    const m = satDijoPorMes([
      sol(2026, 7, "EMITIDOS", "FINISHED", { cfdisFound: 90, createdAt: "2026-09-01T00:00:00Z" }),
      sol(2026, 7, "EMITIDOS", "FINISHED", { cfdisFound: 100, createdAt: "2026-09-02T00:00:00Z" }),
    ]);
    expect(m.get("2026-7")).toBe(100);
  });
});

function entrada(extra: Partial<Parameters<typeof mesesHistorial>[0]> = {}) {
  return {
    hoy: HOY,
    anios: 1,
    inicio: null,
    solicitudes: [] as SolicitudMes[],
    facturas: new Map<string, number>(),
    declaraciones: new Set<string>(),
    balanzas: new Set<string>(),
    ...extra,
  };
}

describe("historial: meses y resumen", () => {
  it("el mes en curso es «cur» y no cuenta en el total", () => {
    const meses = mesesHistorial(entrada());
    expect(meses[0]).toMatchObject({ y: 2026, m: 10, estado: "cur" });
    expect(resumirHistorial(meses).total).toBe(11);
  });

  it("declaración no encontrada sólo entre la primera y la última que sí bajaron", () => {
    const meses = mesesHistorial(entrada({ declaraciones: new Set(["2026-03", "2026-06"]) }));
    const decl = (m: number) => meses.find((x) => x.y === 2026 && x.m === m)?.decl;
    expect(decl(3)).toBe("si");
    expect(decl(4)).toBe("no");
    expect(decl(5)).toBe("no");
    expect(decl(6)).toBe("si");
    expect(decl(7)).toBeNull();
    expect(decl(2)).toBeNull();
  });

  it("sin declaraciones descargadas no se alarma con nada", () => {
    expect(mesesHistorial(entrada()).every((x) => x.decl === null)).toBe(true);
  });

  it("lo reciente está listo cuando los 3 meses cerrados más nuevos están ok", () => {
    const listos = [9, 8, 7].flatMap((m) => [sol(2026, m, "EMITIDOS", "FINISHED"), sol(2026, m, "RECIBIDOS", "FINISHED")]);
    const r = resumirHistorial(mesesHistorial(entrada({ solicitudes: listos })));
    expect(r.ok).toBe(3);
    expect(r.recienteListo).toBe(true);
    expect(r.completo).toBe(false);
    const r2 = resumirHistorial(mesesHistorial(entrada({ solicitudes: listos.slice(0, 4) })));
    expect(r2.recienteListo).toBe(false);
  });

  it("la balanza y las facturas se pegan al mes", () => {
    const meses = mesesHistorial(entrada({ balanzas: new Set(["2026-9"]), facturas: new Map([["2026-9", 1234]]) }));
    expect(meses[1]).toMatchObject({ m: 9, ce: true, cfdis: 1234 });
  });
});

describe("historial: narración", () => {
  const mes = (m: number, estado: MesHistorial["estado"], extra: Partial<MesHistorial> = {}): MesHistorial => ({
    y: 2026,
    m,
    estado,
    cfdis: 0,
    satDijo: 0,
    decl: null,
    ce: false,
    ...extra,
  });

  it("primera lectura: sólo resume", () => {
    expect(narrar(null, [mes(9, "pendiente")]).map((e) => e.clave)).toEqual(["inicio"]);
    expect(narrar(null, [mes(9, "ok")]).map((e) => e.clave)).toEqual(["retomo"]);
  });

  it("primer mes, cuota y hueco, con cifras reales", () => {
    const antes = [mes(9, "req"), mes(8, "req"), mes(7, "req")];
    const ahora = [mes(9, "ok", { cfdis: 1200 }), mes(8, "quota"), mes(7, "hole", { satDijo: 800, cfdis: 3 })];
    const ev = narrar(antes, ahora);
    expect(ev.find((e) => e.clave.startsWith("ok:"))?.texto).toContain("1,200");
    expect(ev.find((e) => e.clave.startsWith("quota:"))?.clase).toBe("problema");
    const hueco = ev.find((e) => e.clave.startsWith("hole:"));
    expect(hueco?.texto).toContain("800");
    expect(hueco?.texto.startsWith("Julio 2026")).toBe(true);
  });

  it("avisa una vez cuando lo reciente queda listo", () => {
    const antes = [mes(10, "cur"), mes(9, "ok"), mes(8, "ok"), mes(7, "req")];
    const ahora = [mes(10, "cur"), mes(9, "ok"), mes(8, "ok"), mes(7, "ok")];
    expect(narrar(antes, ahora).some((e) => e.clave === "reciente" && e.decir)).toBe(true);
    expect(narrar(ahora, ahora)).toEqual([]);
  });

  it("cifra corta para la celda", () => {
    expect(cifraCorta(950)).toBe("950");
    expect(cifraCorta(1234)).toBe("1.2k");
    expect(cifraCorta(12345)).toBe("12k");
  });
});

describe("progreso", () => {
  it("sanea lo inválido y no retrocede", () => {
    expect(sanearProgreso({ paso: "otro", tono: "x", companyId: "a b" })).toEqual(PROGRESO_INICIAL);
    const p = mezclarProgreso({ ...PROGRESO_INICIAL, paso: "historial" }, { paso: "fiel" });
    expect(p.paso).toBe("historial");
    expect(mezclarProgreso({ ...PROGRESO_INICIAL, paso: "historial" }, { paso: "fiel" }, { permitirRetroceso: true }).paso).toBe("fiel");
  });
  it("el tono sugerido sigue al perfil", () => {
    expect(tonoSugerido("despacho")).toBe("grano");
    expect(tonoSugerido("empresa")).toBe("calma");
  });
});

describe("líneas y recorrido", () => {
  it("cada línea tiene sus tres tonos y escapa lo que viene de fuera", () => {
    expect(t(LINEAS.fiel, "calma")).toContain("USB");
    expect(LINEAS.certLeido("<x> & Co", "AAA010101AAA", null)).toContain("&lt;x&gt; &amp; Co");
    expect(esc('"')).toBe("&quot;");
  });
  it("las cifras y riesgos no cambian entre tonos (opinión negativa)", () => {
    const l = LINEAS.opinionResultado("NEGATIVA");
    if (typeof l === "string") throw new Error();
    for (const tono of ["grano", "bal", "calma"] as const) expect(l[tono]).toContain("negativa");
  });
  it("el recorrido cubre todo el menú, el buscador y el copiloto", () => {
    const ids = PASOS_RECORRIDO.map((p) => p.id);
    for (const id of ["hoy", "facturas", "directorio", "bancos", "nomina", "impuestos", "contabilidad", "cumplimiento", "cartera", "cierre", "empresa", "configuracion", "buscar", "arrastre", "chat"]) {
      expect(ids).toContain(id);
    }
    expect(PASOS_RECORRIDO.filter((p) => p.practico === "arrastre")).toHaveLength(1);
  });
});
