import { describe, it, expect } from "vitest";
import {
  mintOnboardingToken,
  hashOnboardingToken,
  onboardingInviteExpiry,
  evaluarInvitacion,
  ONBOARDING_INVITE_TTL_DAYS,
} from "./onboarding-invite";

describe("mint/hash del token", () => {
  it("el hash guardado corresponde al token crudo (y tolera espacios al teclearlo)", () => {
    const { rawToken, tokenHash } = mintOnboardingToken();
    expect(tokenHash).toBe(hashOnboardingToken(rawToken));
    expect(hashOnboardingToken(`  ${rawToken} `)).toBe(tokenHash); // pegado con espacios
  });

  it("cada token es distinto (alta entropía)", () => {
    const a = mintOnboardingToken();
    const b = mintOnboardingToken();
    expect(a.rawToken).not.toBe(b.rawToken);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it("el token crudo no es el hash (nunca se persiste el crudo)", () => {
    const { rawToken, tokenHash } = mintOnboardingToken();
    expect(rawToken).not.toBe(tokenHash);
  });
});

describe("expiración", () => {
  it("vence a los N días", () => {
    const now = new Date("2026-07-23T00:00:00Z");
    const exp = onboardingInviteExpiry(now);
    expect(exp.getTime() - now.getTime()).toBe(ONBOARDING_INVITE_TTL_DAYS * 86400000);
  });
});

describe("evaluarInvitacion", () => {
  const futura = new Date("2026-08-01T00:00:00Z");
  const pasada = new Date("2026-07-01T00:00:00Z");
  const ahora = new Date("2026-07-23T00:00:00Z");

  it("PENDING vigente → canjeable", () => {
    expect(evaluarInvitacion({ status: "PENDING", expiresAt: futura }, ahora)).toEqual({ ok: true });
  });

  it("nula → no_encontrada", () => {
    expect(evaluarInvitacion(null, ahora)).toEqual({ ok: false, motivo: "no_encontrada" });
  });

  it("revocada / usada / expirada", () => {
    expect(evaluarInvitacion({ status: "REVOKED", expiresAt: futura }, ahora)).toEqual({ ok: false, motivo: "revocada" });
    expect(evaluarInvitacion({ status: "ACCEPTED", expiresAt: futura }, ahora)).toEqual({ ok: false, motivo: "usada" });
    expect(evaluarInvitacion({ status: "PENDING", expiresAt: pasada }, ahora)).toEqual({ ok: false, motivo: "expirada" });
  });
});
