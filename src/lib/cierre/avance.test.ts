import { describe, it, expect } from "vitest";
import { diffCierre, meritaPush, rankDeltas } from "./avance";
import { redactarAviso } from "./plantillas";
import { rankHoy, type FilaHoy } from "./hoy";
import type { PasoEvaluado, SenalPaso } from "./workflow";

function paso(clave: PasoEvaluado["clave"], senales: SenalPaso[], extra: Partial<PasoEvaluado> = {}): PasoEvaluado {
  return {
    clave,
    titulo: clave,
    descripcion: "",
    orden: 0,
    estadoCalculado: senales.some((s) => s.estado === "error") ? "bloquea" : senales.some((s) => s.estado === "warn") ? "atencion" : "listo",
    detalle: senales[0]?.resumen ?? null,
    senales,
    hechos: {},
    hashEvidencia: "h",
    cta: { label: clave, href: `/${clave}` },
    requiereConfirmacion: true,
    ...extra,
  };
}

const ok = (clave: string, resumen = "ok"): SenalPaso => ({ clave, estado: "ok", resumen });
const warn = (clave: string, resumen: string): SenalPaso => ({ clave, estado: "warn", resumen, cta: { label: "Ir", href: "/bancos" } });
const error = (clave: string, resumen: string): SenalPaso => ({ clave, estado: "error", resumen });

describe("diffCierre", () => {
  it("primera corrida: todo lo que no está ok es «nuevo»; lo ok no se avisa", () => {
    const next = [paso("banco", [ok("ce:banco"), warn("ce:sin_clasificar", "43 movimientos sin clasificar")])];
    const d = diffCierre(null, next);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ paso: "banco", senal: "sin_clasificar", direccion: "nuevo", deltaKey: "banco.sin_clasificar.nuevo" });
  });

  it("ok → warn es «empeoró»; warn → ok es «mejoró»; sin cambio no hay delta", () => {
    const prev = [paso("banco", [ok("ce:sin_clasificar"), warn("fx:conciliacion-bancaria", "3 sin conciliar")])];
    const next = [paso("banco", [warn("ce:sin_clasificar", "5 movimientos sin clasificar"), ok("fx:conciliacion-bancaria")])];
    const d = diffCierre(prev, next);
    expect(d.map((x) => x.deltaKey).sort()).toEqual(["banco.conciliacion-bancaria.mejoro", "banco.sin_clasificar.empeoro"]);
    expect(diffCierre(next, next)).toEqual([]);
  });

  it("vencimiento: avisa al cruzar el umbral, no cada día", () => {
    const decl = (dias: number) =>
      paso("declaracion", [warn("fx:declaracion-periodo", "Falta presentar")], { diasRestantes: dias, fechaLimite: "2026-09-17", estadoCalculado: "atencion" });
    expect(diffCierre([decl(5)], [decl(3)]).map((d) => d.deltaKey)).toEqual(["declaracion.fecha_limite.por_vencer"]);
    expect(diffCierre([decl(3)], [decl(2)])).toEqual([]);
    expect(diffCierre([decl(0)], [decl(-1)]).map((d) => d.deltaKey)).toEqual(["declaracion.fecha_limite.vencio"]);
    expect(diffCierre([decl(-1)], [decl(-2)])).toEqual([]);
    expect(diffCierre(null, [decl(-1)]).map((d) => d.deltaKey)).toContain("declaracion.fecha_limite.vencio");
  });

  it("ignora pasos que no aplican", () => {
    const next = [paso("nomina", [warn("fx:nomina", "x")], { estadoCalculado: "no_aplica" })];
    expect(diffCierre(null, next)).toEqual([]);
  });
});

describe("rankDeltas / meritaPush", () => {
  it("vencido > por vencer > error > dinero > resto; sin mejoras; tope 5", () => {
    const next = [
      paso("sat", [error("ce:cfdis", "Sin CFDIs del periodo")]),
      paso("banco", [warn("ce:sin_clasificar", "43 movimientos sin clasificar")]),
      paso("complementos", [warn("fx:complementos-por-emitir", "2 cobros PPD sin REP; $12,000.00 sin complementar")]),
      paso("revision", [warn("x:hallazgos_criticos", "1 hallazgo crítico abierto")]),
      paso("imss", [warn("fx:cuotas-imss", "Cuotas IMSS del mes: $3,000.00 estimado")]),
      paso("declaracion", [warn("fx:declaracion-periodo", "Falta presentar")], { diasRestantes: -2, estadoCalculado: "atencion" }),
    ];
    const prev = [paso("banco", [warn("ce:sin_clasificar", "43 movimientos sin clasificar")]), paso("nomina", [warn("fx:nomina", "1 sin timbrar")])];
    const r = rankDeltas(diffCierre(prev, [...next, paso("nomina", [ok("fx:nomina")])]));
    // Dinero antes que orden del flujo; a igual prioridad manda el orden del
    // flujo (imss va antes que complementos); el sexto se queda fuera.
    expect(r.map((d) => d.deltaKey)).toEqual([
      "declaracion.fecha_limite.vencio",
      "sat.cfdis.nuevo",
      "imss.cuotas-imss.nuevo",
      "complementos.complementos-por-emitir.nuevo",
      "revision.hallazgos_criticos.nuevo",
    ]);
    expect(r.some((d) => d.direccion === "mejoro")).toBe(false);
    expect(meritaPush(r[0])).toBe(true);
    expect(meritaPush(r[1])).toBe(true);
    expect(meritaPush(r[2])).toBe(false);
  });
});

describe("redactarAviso", () => {
  const ctx = { empresa: "Acme SA", year: 2026, month: 8 };
  it("REP pendiente: título con la cifra y acción concreta", () => {
    const [d] = diffCierre(null, [paso("complementos", [warn("fx:complementos-por-emitir", "2 cobros PPD del mes sin REP emitido")])]);
    const a = redactarAviso(d, ctx);
    expect(a.titulo).toBe("Acme SA: 2 cobros PPD del mes sin REP emitido");
    expect(a.cuerpo).toContain("agosto 2026");
    expect(a.cuerpo).toContain("Timbra el complemento de pago");
  });
  it("vencida y por vencer", () => {
    const decl = (dias: number) => paso("declaracion", [warn("fx:declaracion-periodo", "Falta presentar")], { diasRestantes: dias, estadoCalculado: "atencion", detalle: "Falta presentar" });
    const v = redactarAviso(diffCierre(null, [decl(-1)]).find((d) => d.direccion === "vencio")!, ctx);
    expect(v.titulo).toBe("Acme SA: declaración de agosto 2026 vencida");
    const p = redactarAviso(diffCierre(null, [decl(0)]).find((d) => d.direccion === "por_vencer")!, ctx);
    expect(p.titulo).toBe("Acme SA: la declaración de agosto 2026 vence hoy");
  });
});

describe("rankHoy", () => {
  const fila = (over: Partial<FilaHoy>): FilaHoy => ({
    companyId: "c", empresa: "E", rfc: "R", year: 2026, month: 8, periodoLabel: "agosto 2026",
    paso: "banco", tituloPaso: "Bancos", estadoCalculado: "atencion", estado: "PENDIENTE", detalle: null, diasRestantes: null, href: "/cierre",
    ...over,
  });
  it("vencida > bloquea > revisar > por vencer > atención; periodo viejo primero", () => {
    const r = rankHoy([
      fila({ paso: "revision" }),
      fila({ paso: "declaracion", diasRestantes: 2 }),
      fila({ paso: "nomina", estado: "REVISAR", estadoCalculado: "listo" }),
      fila({ paso: "sat", estadoCalculado: "bloquea", month: 9 }),
      fila({ paso: "declaracion", diasRestantes: -4, month: 7 }),
    ]);
    expect(r.map((f) => `${f.paso}:${f.month}`)).toEqual(["declaracion:7", "sat:9", "nomina:8", "declaracion:8", "revision:8"]);
  });
});
