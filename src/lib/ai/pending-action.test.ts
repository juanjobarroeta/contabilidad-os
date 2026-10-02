import { describe, it, expect } from "vitest";
import {
  decideConfirm,
  leerPendientes,
  mismaAccion,
  isReversibleType,
  calcPosponerHasta,
  IRREVERSIBLE_TYPES,
  PENDING_ACTION_TTL_MS,
  type ChatPendingAction,
} from "./pending-action";

function staged(overrides: Partial<ChatPendingAction> = {}): ChatPendingAction {
  return {
    type: "conciliar",
    token: "pa_abc",
    expiresAt: Date.now() + PENDING_ACTION_TTL_MS,
    companyId: "co_1",
    summary: "Conciliar X con Y.",
    payload: { txId: "tx_1", invoiceId: "inv_1" },
    ...overrides,
  } as ChatPendingAction;
}

describe("isReversibleType — lista blanca estricta", () => {
  it("acepta los tipos reversibles, capturas del punto de partida incluidas", () => {
    for (const t of [
      "conciliar",
      "categorizacion",
      "resolver_hallazgo",
      "posponer_hallazgo",
      "marcar_pendiente",
      "confirmar_paso",
      "omitir_paso",
      "fijar_coeficiente",
      "fijar_perdida",
      "fijar_saldo_favor_iva",
      "fijar_agrupador",
      "confirmar_apertura",
    ]) {
      expect(isReversibleType(t)).toBe(true);
    }
  });

  it("RECHAZA cualquier acción irreversible (timbrar/pagar/presentar)", () => {
    for (const t of IRREVERSIBLE_TYPES) {
      expect(isReversibleType(t)).toBe(false);
    }
    expect(isReversibleType("timbrar")).toBe(false);
    expect(isReversibleType("dispersar")).toBe(false);
    expect(isReversibleType("presentar_sat")).toBe(false);
    expect(isReversibleType("")).toBe(false);
  });
});

describe("decideConfirm — máquina de estados", () => {
  const now = 1_000_000;

  it("none cuando no hay acción pendiente", () => {
    expect(decideConfirm(null, "pa_abc", now).status).toBe("none");
  });

  it("ok cuando vigente y el token coincide", () => {
    const pa = staged({ token: "pa_abc", expiresAt: now + 1000 });
    expect(decideConfirm(pa, "pa_abc", now).status).toBe("ok");
  });

  it("ok cuando no se presenta token (el tap autenticado basta)", () => {
    const pa = staged({ expiresAt: now + 1000 });
    expect(decideConfirm(pa, undefined, now).status).toBe("ok");
  });

  it("expired cuando el TTL ya pasó", () => {
    const pa = staged({ token: "pa_abc", expiresAt: now });
    expect(decideConfirm(pa, "pa_abc", now).status).toBe("expired");
    const pa2 = staged({ token: "pa_abc", expiresAt: now - 1 });
    expect(decideConfirm(pa2, "pa_abc", now + 0).status).toBe("expired");
  });

  it("mismatch cuando el token presentado no coincide (propuesta vieja)", () => {
    const pa = staged({ token: "pa_nuevo", expiresAt: now + 1000 });
    expect(decideConfirm(pa, "pa_viejo", now).status).toBe("mismatch");
  });

  it("prioriza expired sobre mismatch (no ejecuta lo caducado)", () => {
    const pa = staged({ token: "pa_nuevo", expiresAt: now });
    expect(decideConfirm(pa, "pa_viejo", now).status).toBe("expired");
  });
});

describe("calcPosponerHasta — espeja /api/hallazgos/[id]", () => {
  it("7d suma siete días", () => {
    const base = new Date("2026-06-01T12:00:00Z");
    const r = calcPosponerHasta("7d", base);
    expect(Math.round((r.getTime() - base.getTime()) / 86400000)).toBe(7);
  });

  it("30d suma treinta días", () => {
    const base = new Date("2026-06-01T12:00:00Z");
    const r = calcPosponerHasta("30d", base);
    expect(Math.round((r.getTime() - base.getTime()) / 86400000)).toBe(30);
  });

  it("fin_de_mes cae el último día del mes", () => {
    const base = new Date(2026, 5, 10, 9, 0, 0); // junio (índice 5)
    const r = calcPosponerHasta("fin_de_mes", base);
    expect(r.getMonth()).toBe(5); // sigue en junio
    expect(r.getDate()).toBe(30); // junio tiene 30 días
  });
});

describe("leerPendientes (varias tarjetas por conversación)", () => {
  it("lee la lista y descarta las vencidas", () => {
    const vieja = staged({ token: "pa_old", expiresAt: 1 });
    const a = staged({ token: "pa_a" });
    const b = staged({ token: "pa_b", payload: { txId: "tx_2", invoiceId: "inv_2" } } as Partial<ChatPendingAction>);
    expect(leerPendientes([vieja, a, b]).map((p) => p.token)).toEqual(["pa_a", "pa_b"]);
  });

  it("acepta el formato viejo (un solo objeto) y la columna vacía", () => {
    expect(leerPendientes(staged()).map((p) => p.token)).toEqual(["pa_abc"]);
    expect(leerPendientes(null)).toEqual([]);
  });
});

describe("mismaAccion", () => {
  it("ignora el orden de las llaves (jsonb las reordena) y distingue objetivos", () => {
    const a = staged({ payload: { txId: "tx_1", invoiceId: "inv_1" } } as Partial<ChatPendingAction>);
    const b = staged({ payload: { invoiceId: "inv_1", txId: "tx_1" } } as Partial<ChatPendingAction>);
    const c = staged({ payload: { txId: "tx_2", invoiceId: "inv_1" } } as Partial<ChatPendingAction>);
    expect(mismaAccion(a, b)).toBe(true);
    expect(mismaAccion(a, c)).toBe(false);
  });
});
