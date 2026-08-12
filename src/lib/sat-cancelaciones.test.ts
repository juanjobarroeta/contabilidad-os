import { describe, expect, it } from "vitest";
import {
  esEstatusCancelado,
  interpretarCancelaciones,
  mesesBacklogCancelaciones,
  mesesVentanaCancelable,
  ordenEmpresasPorAntiguedad,
} from "./sat-cancelaciones";

describe("mesesVentanaCancelable", () => {
  // Hasta abril, lo del ejercicio anterior sigue cancelable (anual PM marzo /
  // PF abril): la ventana debe llegar a enero del año pasado.
  it.each([
    ["2026-01-15", 13],
    ["2026-03-31", 15],
    ["2026-04-30", 16], // máximo: abril cubre ene(N-1)..abr(N)
  ])("%s → %i meses (cubre el ejercicio anterior)", (fecha, esperado) => {
    expect(mesesVentanaCancelable(new Date(`${fecha}T12:00:00`))).toBe(esperado);
  });

  // De mayo en adelante sólo el ejercicio en curso es cancelable.
  it.each([
    ["2026-05-01", 5], // mínimo
    ["2026-08-10", 8],
    ["2026-12-31", 12],
  ])("%s → %i meses (sólo el ejercicio en curso)", (fecha, esperado) => {
    expect(mesesVentanaCancelable(new Date(`${fecha}T12:00:00`))).toBe(esperado);
  });
});

describe("mesesBacklogCancelaciones (gate por mes)", () => {
  const xml = (y: number, m: number) => [
    { year: y, month: m, tipo: "EMITIDOS" },
    { year: y, month: m, tipo: "RECIBIDOS" },
  ];
  const meta = (y: number, m: number) => [
    { year: y, month: m, tipo: "METADATA_EMITIDOS" },
    { year: y, month: m, tipo: "METADATA_RECIBIDOS" },
  ];

  it("un mes es elegible en cuanto SU XML está completo — sin esperar el backfill entero", () => {
    // 2024-05 importado, 2021 todavía bajando (sólo EMITIDOS): elegible únicamente 2024-05.
    const terminados = [...xml(2024, 5), { year: 2021, month: 3, tipo: "EMITIDOS" }];
    expect(mesesBacklogCancelaciones(terminados, [])).toEqual([{ year: 2024, month: 5 }]);
  });

  it("un mes con metadata terminada no se re-consulta ('hecho' es para siempre)", () => {
    const terminados = [...xml(2024, 5), ...meta(2024, 5), ...xml(2024, 4)];
    expect(mesesBacklogCancelaciones(terminados, [])).toEqual([{ year: 2024, month: 4 }]);
  });

  it("metadata a medias (un solo lado) sigue pendiente", () => {
    const terminados = [...xml(2024, 5), { year: 2024, month: 5, tipo: "METADATA_EMITIDOS" }];
    expect(mesesBacklogCancelaciones(terminados, [])).toEqual([{ year: 2024, month: 5 }]);
  });

  it("excluye la ventana rodante y ordena del más nuevo al más viejo", () => {
    const terminados = [...xml(2026, 7), ...xml(2023, 11), ...xml(2024, 2)];
    expect(mesesBacklogCancelaciones(terminados, [{ year: 2026, month: 7 }])).toEqual([
      { year: 2024, month: 2 },
      { year: 2023, month: 11 },
    ]);
  });
});

describe("esEstatusCancelado", () => {
  it("reconoce '0' y texto 'Cancelado' (con espacios/mayúsculas)", () => {
    expect(esEstatusCancelado("0")).toBe(true);
    expect(esEstatusCancelado(" Cancelado ")).toBe(true);
    expect(esEstatusCancelado("CANCELADO")).toBe(true);
  });
  it("vigente/vacío/null no cancelan", () => {
    expect(esEstatusCancelado("1")).toBe(false);
    expect(esEstatusCancelado("Vigente")).toBe(false);
    expect(esEstatusCancelado("")).toBe(false);
    expect(esEstatusCancelado(null)).toBe(false);
  });
});

describe("interpretarCancelaciones", () => {
  const owned = [
    { id: "a", uuid: "AAAA-1111", status: "STAMPED" },
    { id: "b", uuid: "bbbb-2222", status: "STAMPED" }, // minúsculas en BD
    { id: "c", uuid: "CCCC-3333", status: "CANCELLED" },
    { id: "d", uuid: "DDDD-4444", status: "DRAFT" },
  ];

  it("cancela sólo STAMPED que el SAT reporta cancelados, case-insensitive", () => {
    const r = interpretarCancelaciones(
      [
        { uuid: "AAAA-1111", estatus: "0", fechaCancelacion: "2026-07-01" },
        { uuid: "BBBB-2222", estatus: "Cancelado" },
        { uuid: "CCCC-3333", estatus: "0" }, // ya CANCELLED → idempotente
        { uuid: "DDDD-4444", estatus: "0" }, // DRAFT → no se toca
        { uuid: "EEEE-5555", estatus: "0" }, // no lo conocemos → no se crea nada
        { uuid: "AAAA-1111", estatus: "0" }, // duplicado en el paquete → una vez
      ],
      owned,
    );
    expect(r.toCancel.map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(r.canceladosEnSat).toBe(5);
    expect(r.vistos).toBe(5); // el duplicado cuenta una vez
  });

  it("los vigentes no generan cancelaciones", () => {
    const r = interpretarCancelaciones([{ uuid: "AAAA-1111", estatus: "1" }], owned);
    expect(r.toCancel).toEqual([]);
  });
});

describe("ordenEmpresasPorAntiguedad", () => {
  const e = (id: string) => ({ id });

  it("las NUNCA consultadas van primero — la empresa recién onboardeada no se queda sin turno", () => {
    const empresas = [e("vieja"), e("nueva"), e("media")];
    const ultima = new Map<string, Date | null>([
      ["vieja", new Date("2026-08-01T00:00:00Z")],
      ["media", new Date("2026-08-10T00:00:00Z")],
      // "nueva" no aparece: jamás se le consultó metadata.
    ]);
    expect(ordenEmpresasPorAntiguedad(empresas, ultima).map((x) => x.id)).toEqual([
      "nueva", "vieja", "media",
    ]);
  });

  it("entre consultadas, primero la más antigua (rotación entre corridas)", () => {
    const empresas = [e("b"), e("a")];
    const ultima = new Map<string, Date | null>([
      ["a", new Date("2026-08-11T00:00:00Z")],
      ["b", new Date("2026-08-09T00:00:00Z")],
    ]);
    expect(ordenEmpresasPorAntiguedad(empresas, ultima).map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("un valor null explícito cuenta como nunca consultada", () => {
    const ultima = new Map<string, Date | null>([
      ["x", new Date("2026-08-01T00:00:00Z")],
      ["y", null],
    ]);
    expect(ordenEmpresasPorAntiguedad([e("x"), e("y")], ultima).map((v) => v.id)).toEqual(["y", "x"]);
  });

  it("empate → orden determinista por id (recorrido reproducible)", () => {
    const t = new Date("2026-08-10T00:00:00Z");
    const ultima = new Map<string, Date | null>([["b", t], ["a", t]]);
    expect(ordenEmpresasPorAntiguedad([e("b"), e("a")], ultima).map((v) => v.id)).toEqual(["a", "b"]);
  });

  it("no muta el arreglo original", () => {
    const empresas = [e("z"), e("a")];
    ordenEmpresasPorAntiguedad(empresas, new Map());
    expect(empresas.map((v) => v.id)).toEqual(["z", "a"]);
  });
});
