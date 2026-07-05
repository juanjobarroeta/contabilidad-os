import { describe, it, expect } from "vitest";
import {
  mintStagedToken,
  hashStagedToken,
  checkStagedActionUsable,
  stagedActionErrorMessage,
  isStagedActionType,
  stagedActionExpiry,
  STAGED_ACTION_TTL_MS,
} from "./staged-action";

describe("mintStagedToken / hashStagedToken", () => {
  it("acuña un token crudo distinto cada vez y su hash determinista", () => {
    const a = mintStagedToken();
    const b = mintStagedToken();
    expect(a.rawToken).not.toBe(b.rawToken);
    expect(a.tokenHash).toHaveLength(64); // sha256 hex
    expect(hashStagedToken(a.rawToken)).toBe(a.tokenHash);
    expect(hashStagedToken(a.rawToken)).not.toBe(a.tokenHash.slice(1)); // sanity
  });

  it("el hash cambia si el token cambia", () => {
    expect(hashStagedToken("abc")).not.toBe(hashStagedToken("abd"));
  });
});

describe("isStagedActionType", () => {
  it("solo acepta tipos de la lista blanca", () => {
    expect(isStagedActionType("timbrar")).toBe(true);
    expect(isStagedActionType("complemento_pago")).toBe(true);
    expect(isStagedActionType("dispersar")).toBe(false);
    expect(isStagedActionType("")).toBe(false);
  });
});

describe("checkStagedActionUsable", () => {
  const futuro = new Date(Date.now() + 10 * 60 * 1000);
  const pasado = new Date(Date.now() - 1000);

  it("null si está PENDING y vigente", () => {
    expect(checkStagedActionUsable({ status: "PENDING", expiresAt: futuro })).toBeNull();
  });

  it("not_found si no existe", () => {
    expect(checkStagedActionUsable(null)).toBe("not_found");
  });

  it("expired si venció el TTL aunque siga PENDING", () => {
    expect(checkStagedActionUsable({ status: "PENDING", expiresAt: pasado })).toBe("expired");
  });

  it("cancelled si fue descartada", () => {
    expect(checkStagedActionUsable({ status: "CANCELLED", expiresAt: futuro })).toBe("cancelled");
  });

  it("used para cualquier estado ya consumido (un solo uso, sin reintento)", () => {
    expect(checkStagedActionUsable({ status: "EXECUTING", expiresAt: futuro })).toBe("used");
    expect(checkStagedActionUsable({ status: "DONE", expiresAt: futuro })).toBe("used");
    expect(checkStagedActionUsable({ status: "FAILED", expiresAt: futuro })).toBe("used");
  });

  it("prioriza cancelled sobre expired", () => {
    expect(checkStagedActionUsable({ status: "CANCELLED", expiresAt: pasado })).toBe("cancelled");
  });
});

describe("stagedActionErrorMessage", () => {
  it("da un mensaje para cada motivo", () => {
    for (const err of ["not_found", "expired", "used", "cancelled"] as const) {
      expect(stagedActionErrorMessage(err)).toBeTruthy();
    }
  });
});

describe("stagedActionExpiry", () => {
  it("expira a los 30 minutos", () => {
    const now = new Date("2026-07-05T12:00:00.000Z");
    expect(stagedActionExpiry(now).getTime()).toBe(now.getTime() + STAGED_ACTION_TTL_MS);
    expect(STAGED_ACTION_TTL_MS).toBe(30 * 60 * 1000);
  });
});
