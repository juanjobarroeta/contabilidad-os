import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluarCierre } from "./evaluar";
import type { EstadoCierreCanonico } from "./estado-canonico";
import { compuertaParaEstado, evaluarCompuertaEntregable } from "./compuerta-entregables";

vi.mock("./evaluar", () => ({ evaluarCierre: vi.fn() }));

function estado(over: Partial<EstadoCierreCanonico> = {}): EstadoCierreCanonico {
  return {
    fase: "CONTABILIZADO",
    estadoContable: "POSTED",
    declarado: false,
    origenCierre: null,
    listo: true,
    contabilizado: true,
    cerrado: false,
    descargable: true,
    puedeContabilizar: false,
    bloqueos: [],
    ...over,
  };
}

describe("compuertaParaEstado", () => {
  it("permite un ledger contabilizado y sin bloqueos", () => {
    expect(compuertaParaEstado(estado())).toEqual({ ok: true, estado: estado() });
  });

  it("devuelve el mismo 409 accionable para cualquier bloqueo canónico", () => {
    const bloqueado = estado({
      fase: "BLOQUEADO",
      listo: false,
      contabilizado: false,
      descargable: false,
      bloqueos: [{ paso: "banco", titulo: "Bancos", tipo: "MOTOR", detalle: "3 movimientos sin conciliar" }],
    });
    expect(compuertaParaEstado(bloqueado)).toEqual({
      ok: false,
      status: 409,
      body: {
        code: "CIERRE_NO_DESCARGABLE",
        error: "El periodo tiene bloqueos activos: 3 movimientos sin conciliar",
        estado: bloqueado,
      },
    });
  });

  it("no confunde un cierre externo con un entregable generado aquí", () => {
    const externo = estado({
      fase: "CERRADO",
      estadoContable: null,
      declarado: true,
      origenCierre: "FUERA_DE_CONTABILIDAD_OS",
      contabilizado: false,
      cerrado: true,
      descargable: false,
      puedeContabilizar: true,
    });
    const r = compuertaParaEstado(externo);
    expect(r).toMatchObject({
      ok: false,
      status: 409,
      body: { code: "CIERRE_NO_DESCARGABLE", error: expect.stringMatching(/Contabiliza el periodo/) },
    });
  });
});

describe("evaluarCompuertaEntregable", () => {
  const evaluar = vi.mocked(evaluarCierre);

  beforeEach(() => evaluar.mockReset());

  it("lee evidencia fresca para cada descarga mensual", async () => {
    const vigente = estado();
    evaluar.mockResolvedValue({ estado: vigente } as Awaited<ReturnType<typeof evaluarCierre>>);
    await expect(evaluarCompuertaEntregable("empresa", 2026, 8)).resolves.toEqual({
      ok: true,
      estado: vigente,
    });
    expect(evaluar).toHaveBeenCalledWith("empresa", 2026, 8, { fresco: true });
  });

  it("deja el mes 13 en su guarda anual sin ejecutar el flujo fiscal mensual", async () => {
    await expect(evaluarCompuertaEntregable("empresa", 2025, 13)).resolves.toEqual({
      ok: true,
      estado: null,
    });
    expect(evaluar).not.toHaveBeenCalled();
  });
});
