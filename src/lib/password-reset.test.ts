import { describe, it, expect } from "vitest";
import {
  mintResetToken,
  hashResetToken,
  resetTokenExpiry,
  evaluarResetToken,
  PASSWORD_RESET_TTL_MIN,
} from "./password-reset";

describe("mintResetToken / hashResetToken", () => {
  it("acuña tokens únicos cuyo hash coincide con hashResetToken", () => {
    const a = mintResetToken();
    const b = mintResetToken();
    expect(a.rawToken).not.toBe(b.rawToken);
    expect(a.tokenHash).toBe(hashResetToken(a.rawToken));
    expect(a.tokenHash).toHaveLength(64); // sha256 hex
  });

  it("el hash tolera espacios alrededor (copy-paste de WhatsApp)", () => {
    const { rawToken, tokenHash } = mintResetToken();
    expect(hashResetToken(`  ${rawToken}\n`)).toBe(tokenHash);
  });
});

describe("resetTokenExpiry", () => {
  it("vence PASSWORD_RESET_TTL_MIN minutos después", () => {
    const now = new Date("2026-07-31T12:00:00Z");
    expect(resetTokenExpiry(now).getTime() - now.getTime()).toBe(PASSWORD_RESET_TTL_MIN * 60 * 1000);
  });
});

describe("evaluarResetToken", () => {
  const now = new Date("2026-07-31T12:00:00Z");
  const vigente = { usedAt: null, expiresAt: new Date("2026-07-31T12:30:00Z") };

  it("acepta un token vigente y sin usar", () => {
    expect(evaluarResetToken(vigente, now)).toEqual({ ok: true });
  });

  it("rechaza token inexistente", () => {
    expect(evaluarResetToken(null, now)).toEqual({ ok: false, motivo: "no_encontrado" });
  });

  it("rechaza token ya usado", () => {
    expect(evaluarResetToken({ ...vigente, usedAt: new Date("2026-07-31T11:59:00Z") }, now)).toEqual({
      ok: false,
      motivo: "usado",
    });
  });

  it("rechaza token expirado (límite inclusive)", () => {
    expect(evaluarResetToken({ ...vigente, expiresAt: now }, now)).toEqual({ ok: false, motivo: "expirado" });
  });
});
