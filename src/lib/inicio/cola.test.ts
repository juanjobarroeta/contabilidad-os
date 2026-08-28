import { describe, expect, it } from "vitest";
import { armarCola, filasDeEmpresa, type SenalesEmpresa } from "./cola";

function empresa(over: Partial<SenalesEmpresa> = {}): SenalesEmpresa {
  return {
    companyId: "c1",
    razonSocial: "MARGOM",
    rfc: "MAR010101AAA",
    declaracion: { estado: "presentada", aPagar: null, periodoLabel: "julio", venceLabel: "17 ago" },
    nomina: { runsSinTimbrar: [], corridasDelMes: 1, empleadosActivos: 10, setupCompleto: true },
    banco: { sinClasificar: 0 },
    cierre: { mesAnteriorPosteado: true, label: "julio" },
    hallazgosCriticos: 0,
    ...over,
  };
}

describe("filasDeEmpresa — una acción por problema, en orden", () => {
  it("empresa limpia y posteada: cola vacía", () => {
    expect(filasDeEmpresa(empresa(), { diaDelMes: 20 })).toEqual([]);
  });

  it("declaración vencida: fila FISCAL con recargos, monto y verbo Presentar", () => {
    const f = filasDeEmpresa(
      empresa({ declaracion: { estado: "vencida", aPagar: 148220, periodoLabel: "julio", venceLabel: "17 ago" } }),
      { diaDelMes: 27 },
    );
    expect(f[0]).toMatchObject({
      categoria: "FISCAL",
      urgencia: "vencido",
      monto: 148220,
      vence: "venció 17 ago",
      cta: { label: "Presentar", href: "/impuestos" },
    });
    expect(f[0].detalle).toContain("CFF 17-A");
  });

  it("corrida calculada sin timbrar: NOMINA hoy con neto y recibos", () => {
    const f = filasDeEmpresa(
      empresa({
        nomina: {
          runsSinTimbrar: [{ totalNeto: 52605, empleados: 7 }],
          corridasDelMes: 1,
          empleadosActivos: 7,
          setupCompleto: true,
        },
      }),
      { diaDelMes: 27 },
    );
    expect(f[0]).toMatchObject({ categoria: "NOMINA", urgencia: "hoy", monto: 52605 });
    expect(f[0].detalle).toContain("7 recibos");
  });

  it("sin corrida del mes pasada la quincena: Calcular; antes del 13, silencio", () => {
    const sinCorrida = empresa({
      nomina: { runsSinTimbrar: [], corridasDelMes: 0, empleadosActivos: 1, setupCompleto: true },
    });
    expect(filasDeEmpresa(sinCorrida, { diaDelMes: 27 })[0]).toMatchObject({
      categoria: "NOMINA",
      cta: { label: "Calcular", href: "/nomina?tab=corridas" },
    });
    expect(filasDeEmpresa(sinCorrida, { diaDelMes: 10 })).toEqual([]);
  });

  it("cerrar mes sólo con la fila limpia: presentada + banco al día + nada por timbrar", () => {
    const lista = empresa({ cierre: { mesAnteriorPosteado: false, label: "julio" } });
    expect(filasDeEmpresa(lista, { diaDelMes: 27 })[0]).toMatchObject({
      categoria: "CIERRE",
      urgencia: "cuando_quieras",
      cta: { label: "Cerrar mes", href: "/contabilidad/cierre" },
    });
    const sucia = empresa({
      cierre: { mesAnteriorPosteado: false, label: "julio" },
      banco: { sinClasificar: 3 },
    });
    const filas = filasDeEmpresa(sucia, { diaDelMes: 27 });
    expect(filas.some((f) => f.categoria === "CIERRE")).toBe(false);
    expect(filas[0].categoria).toBe("BANCOS");
  });
});

describe("armarCola — ranking global y resumen", () => {
  it("vencido primero, luego hoy, luego pronto; a igual urgencia gana el monto", () => {
    const { filas } = armarCola(
      [
        empresa({ companyId: "a", razonSocial: "A", banco: { sinClasificar: 5 } }),
        empresa({
          companyId: "b",
          razonSocial: "B",
          declaracion: { estado: "vencida", aPagar: 1000, periodoLabel: "julio", venceLabel: "17 ago" },
        }),
        empresa({
          companyId: "c",
          razonSocial: "C",
          declaracion: { estado: "vencida", aPagar: 99000, periodoLabel: "julio", venceLabel: "17 ago" },
        }),
        empresa({
          companyId: "d",
          razonSocial: "D",
          nomina: { runsSinTimbrar: [{ totalNeto: 5, empleados: 1 }], corridasDelMes: 1, empleadosActivos: 1, setupCompleto: true },
        }),
      ],
      { diaDelMes: 27 },
    );
    expect(filas.map((f) => f.empresa)).toEqual(["C", "B", "D", "A"]);
  });

  it("máximo de filas por empresa respetado y resumen correcto", () => {
    const caotica = empresa({
      companyId: "x",
      razonSocial: "X",
      declaracion: { estado: "vencida", aPagar: null, periodoLabel: "julio", venceLabel: "17 ago" },
      nomina: { runsSinTimbrar: [{ totalNeto: 100, empleados: 2 }], corridasDelMes: 0, empleadosActivos: 2, setupCompleto: false },
      banco: { sinClasificar: 43 },
    });
    const { filas, resumen } = armarCola([caotica], { diaDelMes: 27, maxFilasPorEmpresa: 2 });
    expect(filas).toHaveLength(2); // FISCAL + NOMINA — bancos y setup quedan fuera del corte
    expect(resumen).toEqual({
      vencidoMonto: 0,
      vencidoSinImporte: 1,
      rfcsVencidos: 1,
      declaracionesPorPresentar: 1,
      nominasSinTimbrar: 1,
      movimientosSinClasificar: 43,
    });
  });
});
