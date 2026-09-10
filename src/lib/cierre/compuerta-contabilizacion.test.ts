import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EstadoCierreCanonico } from "./estado-canonico";

const mocks = vi.hoisted(() => ({
  evaluarCierre: vi.fn(),
  invalidarCierre: vi.fn(),
}));

vi.mock("./evaluar", () => ({
  evaluarCierre: mocks.evaluarCierre,
  invalidarCierre: mocks.invalidarCierre,
}));

import {
  compuertaParaContabilizacion,
  evaluarCompuertaContabilizacion,
  invalidarCompuertaContabilizacion,
} from "./compuerta-contabilizacion";

function estado(over: Partial<EstadoCierreCanonico> = {}): EstadoCierreCanonico {
  return {
    fase: "LISTO",
    estadoContable: "DRAFT",
    declarado: false,
    origenCierre: null,
    listo: true,
    contabilizado: false,
    cerrado: false,
    descargable: false,
    puedeContabilizar: true,
    bloqueos: [],
    ...over,
  };
}

describe("compuertaParaContabilizacion", () => {
  it("permite la primera contabilización de un periodo listo", () => {
    expect(compuertaParaContabilizacion(estado())).toMatchObject({
      ok: true,
      operacion: "CONTABILIZAR",
    });
  });

  it("permite regenerar un periodo POSTED que sigue abierto y limpio", () => {
    expect(
      compuertaParaContabilizacion(
        estado({
          fase: "CONTABILIZADO",
          estadoContable: "POSTED",
          contabilizado: true,
          descargable: true,
          puedeContabilizar: false,
        })
      )
    ).toMatchObject({ ok: true, operacion: "RECONTABILIZAR" });
  });

  it("bloquea con el detalle canónico vigente", () => {
    const bloqueado = estado({
      fase: "BLOQUEADO",
      listo: false,
      puedeContabilizar: false,
      bloqueos: [
        {
          paso: "banco",
          titulo: "Bancos",
          tipo: "MOTOR",
          detalle: "3 movimientos sin conciliar",
        },
      ],
    });
    expect(compuertaParaContabilizacion(bloqueado)).toEqual({
      ok: false,
      status: 409,
      body: {
        code: "CIERRE_NO_CONTABILIZABLE",
        error: "El periodo tiene bloqueos activos: 3 movimientos sin conciliar",
        estado: bloqueado,
      },
    });
  });

  it("exige reapertura explícita antes de regenerar un periodo declarado", () => {
    const cerrado = estado({
      fase: "CERRADO",
      estadoContable: "POSTED",
      declarado: true,
      origenCierre: "CONTABILIDAD_OS",
      contabilizado: true,
      cerrado: true,
      descargable: true,
      puedeContabilizar: false,
    });
    expect(compuertaParaContabilizacion(cerrado)).toMatchObject({
      ok: false,
      status: 409,
      body: {
        code: "CIERRE_NO_CONTABILIZABLE",
        error: expect.stringMatching(/declaración presentada.*Reábrelo/i),
      },
    });
  });

  it("permite la primera reconstrucción local de un cierre histórico externo", () => {
    expect(
      compuertaParaContabilizacion(
        estado({
          fase: "CERRADO",
          estadoContable: null,
          declarado: true,
          origenCierre: "FUERA_DE_CONTABILIDAD_OS",
          cerrado: true,
        })
      )
    ).toMatchObject({ ok: true, operacion: "CONTABILIZAR" });
  });
});

describe("evaluarCompuertaContabilizacion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("siempre evalúa evidencia fresca e invalida la memo después de escribir", async () => {
    const vigente = estado();
    mocks.evaluarCierre.mockResolvedValue({ estado: vigente });

    await expect(
      evaluarCompuertaContabilizacion("empresa", 2026, 8)
    ).resolves.toMatchObject({ ok: true });
    expect(mocks.evaluarCierre).toHaveBeenCalledWith("empresa", 2026, 8, {
      fresco: true,
    });

    invalidarCompuertaContabilizacion("empresa", 2026, 8);
    expect(mocks.invalidarCierre).toHaveBeenCalledWith("empresa", 2026, 8);
  });
});
