import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Mock de prisma.bankTransaction.findFirst con almacén en memoria ───────
// Implementa lo mínimo que usa el SUT: findFirst con los filtros exactos
// (bankAccountId + externalRef not-null / source in [...]).

type Row = {
  id: string;
  bankAccountId: string;
  source: string;
  externalRef: string | null;
};

const state = vi.hoisted(() => ({ rows: [] as Row[] }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bankTransaction: {
      findFirst: async ({
        where,
      }: {
        where: {
          bankAccountId: string;
          externalRef?: { not: null };
          source?: { in: string[] };
        };
      }) => {
        const hit = state.rows.find((r) => {
          if (r.bankAccountId !== where.bankAccountId) return false;
          if (where.externalRef) return r.externalRef !== null;
          if (where.source) return where.source.in.includes(r.source);
          return true;
        });
        return hit ? { id: hit.id } : null;
      },
    },
  },
}));

import {
  cuentaTieneEstadosDeCuenta,
  cuentaTieneIngestExterno,
  FUENTES_ESTADO_DE_CUENTA,
} from "./fuentes";

let seq = 0;
const row = (bankAccountId: string, source: string, externalRef: string | null = null): Row => ({
  id: `tx${++seq}`,
  bankAccountId,
  source,
  externalRef,
});

beforeEach(() => {
  state.rows = [];
});

describe("cuentaTieneIngestExterno", () => {
  it("true cuando la cuenta tiene movimientos empujados por una app (externalRef)", async () => {
    state.rows = [row("puente", "JCPT", "jcpt:stripe:in_123")];
    expect(await cuentaTieneIngestExterno("puente")).toBe(true);
  });

  it("false para una cuenta alimentada sólo por estados de cuenta", async () => {
    state.rows = [row("real", "UPLOAD"), row("real", "BELVO")];
    expect(await cuentaTieneIngestExterno("real")).toBe(false);
  });

  it("false para una cuenta vacía y no se cruza entre cuentas", async () => {
    state.rows = [row("puente", "PADEL", "padel:abc")];
    expect(await cuentaTieneIngestExterno("otra")).toBe(false);
  });
});

describe("cuentaTieneEstadosDeCuenta", () => {
  it("true con cualquier fuente de estado de cuenta (UPLOAD, UPLOAD_PDF, BELVO)", async () => {
    for (const fuente of FUENTES_ESTADO_DE_CUENTA) {
      state.rows = [row("real", fuente)];
      expect(await cuentaTieneEstadosDeCuenta("real")).toBe(true);
    }
  });

  it("false para una cuenta puente alimentada sólo por ingest externo", async () => {
    state.rows = [row("puente", "JCPT", "jcpt:stripe:in_123")];
    expect(await cuentaTieneEstadosDeCuenta("puente")).toBe(false);
  });
});
