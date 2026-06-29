import { describe, it, expect } from "vitest";
import {
  mintInviteToken,
  hashInviteToken,
  inviteExpiry,
  checkInviteAcceptable,
  buildAcceptUrl,
  CLIENT_INVITE_ROLES,
  INVITE_TTL_DAYS,
} from "./invitations";

describe("mintInviteToken / hashInviteToken", () => {
  it("produce un token crudo de alta entropía y su hash SHA-256", () => {
    const { rawToken, tokenHash } = mintInviteToken();
    expect(rawToken.length).toBeGreaterThan(20);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // El hash es determinista respecto al token crudo.
    expect(hashInviteToken(rawToken)).toBe(tokenHash);
  });

  it("dos tokens distintos no colisionan", () => {
    const a = mintInviteToken();
    const b = mintInviteToken();
    expect(a.rawToken).not.toBe(b.rawToken);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});

describe("inviteExpiry", () => {
  it("expira INVITE_TTL_DAYS después de la referencia", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const exp = inviteExpiry(now);
    expect(exp.getTime() - now.getTime()).toBe(INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  });
});

describe("checkInviteAcceptable", () => {
  const now = new Date("2026-06-29T12:00:00.000Z");
  const future = new Date("2026-07-06T12:00:00.000Z");
  const past = new Date("2026-06-01T12:00:00.000Z");
  const base = { status: "PENDING" as const, expiresAt: future, email: "cliente@example.com" };

  it("acepta una invitación PENDING vigente para el correo correcto (case-insensitive)", () => {
    expect(checkInviteAcceptable(base, "cliente@example.com", now)).toBeNull();
    expect(checkInviteAcceptable(base, "Cliente@Example.com", now)).toBeNull();
  });

  it("rechaza invitación inexistente", () => {
    expect(checkInviteAcceptable(null, "cliente@example.com", now)).toBe("not_found");
  });

  it("rechaza revocada", () => {
    expect(checkInviteAcceptable({ ...base, status: "REVOKED" }, "cliente@example.com", now)).toBe("revoked");
  });

  it("rechaza expirada (solo aplica a PENDING)", () => {
    expect(checkInviteAcceptable({ ...base, expiresAt: past }, "cliente@example.com", now)).toBe("expired");
  });

  it("rechaza correo distinto al invitado", () => {
    expect(checkInviteAcceptable(base, "otro@example.com", now)).toBe("email_mismatch");
  });

  it("el límite de expiración es exclusivo (vencida exactamente al instante)", () => {
    expect(checkInviteAcceptable({ ...base, expiresAt: now }, "cliente@example.com", now)).toBe("expired");
  });
});

describe("buildAcceptUrl", () => {
  it("incrusta el token crudo en la ruta de aceptación", () => {
    expect(buildAcceptUrl("abc123")).toMatch(/\/invitacion\/abc123$/);
  });
});

describe("CLIENT_INVITE_ROLES", () => {
  it("nunca otorga acceso a nivel despacho (solo roles de empresa)", () => {
    // El invariante de aislamiento: un cliente invitado jamás recibe rol de
    // despacho. Los roles permitidos son estrictamente de empresa.
    expect(CLIENT_INVITE_ROLES).toContain("VIEWER");
    for (const r of CLIENT_INVITE_ROLES) {
      expect(["VIEWER", "ACCOUNTANT"]).toContain(r);
    }
  });
});
