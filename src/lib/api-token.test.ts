import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { decodeJwt } from "jose";

process.env.AUTH_SECRET = "secreto-de-prueba-para-tokens-api";

import {
  signApiToken,
  signLegacyApiToken,
  signClubMemberToken,
  verifyApiToken,
  legacyApiTokensEnabled,
  ACCESS_TOKEN_EXPIRY_SECONDS,
} from "./api-token";

const usuario = { sub: "u1", email: "robot@satelite.mx", name: "Robot" };

beforeAll(() => {
  process.env.AUTH_SECRET = "secreto-de-prueba-para-tokens-api";
});

describe("access token nuevo (1 hora, jti, scope opcional)", () => {
  it("firma y verifica con jti único y SIN scope cuando no se pide", async () => {
    const t1 = await signApiToken(usuario);
    const t2 = await signApiToken(usuario);
    const p1 = await verifyApiToken(t1);
    const p2 = await verifyApiToken(t2);

    expect(p1.sub).toBe("u1");
    expect(p1.email).toBe("robot@satelite.mx");
    expect(p1.jti).toBeTruthy();
    expect(p2.jti).toBeTruthy();
    expect(p1.jti).not.toBe(p2.jti); // jti único por emisión
    expect(p1.scope).toBeUndefined(); // sin scope = acceso total
  });

  it("expira en 1 hora (claim exp)", async () => {
    const token = await signApiToken(usuario);
    const claims = decodeJwt(token);
    const vida = (claims.exp ?? 0) - (claims.iat ?? 0);
    expect(vida).toBe(ACCESS_TOKEN_EXPIRY_SECONDS);
  });

  it("incluye el claim scope cuando se pide y lo devuelve al verificar", async () => {
    const token = await signApiToken(usuario, { scope: "clientes facturas" });
    const payload = await verifyApiToken(token);
    expect(payload.scope).toBe("clientes facturas");
  });

  it("scope vacío o solo espacios NO agrega el claim", async () => {
    const token = await signApiToken(usuario, { scope: "   " });
    const payload = await verifyApiToken(token);
    expect(payload.scope).toBeUndefined();
  });
});

describe("compatibilidad con tokens legados de 7 días", () => {
  it("un token legado (sin jti/scope) sigue verificando — satélites vivos no se rompen", async () => {
    const token = await signLegacyApiToken(usuario);
    const payload = await verifyApiToken(token);
    expect(payload.sub).toBe("u1");
    expect(payload.jti).toBeUndefined();
    expect(payload.scope).toBeUndefined();

    const claims = decodeJwt(token);
    const vida = (claims.exp ?? 0) - (claims.iat ?? 0);
    expect(vida).toBe(7 * 24 * 60 * 60); // 7 días exactos, como siempre
  });

  it("verifyApiToken RECHAZA tokens de socios del club (audiencia distinta)", async () => {
    const member = await signClubMemberToken({
      sub: "m1",
      email: "socio@club.mx",
      name: "Socio",
      companyId: "c1",
    });
    await expect(verifyApiToken(member)).rejects.toThrow();
  });
});

describe("legacyApiTokensEnabled (bandera de emisión legada)", () => {
  const original = process.env.LEGACY_API_TOKENS_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.LEGACY_API_TOKENS_ENABLED;
    else process.env.LEGACY_API_TOKENS_ENABLED = original;
  });

  it("apagada por omisión (env ausente)", () => {
    delete process.env.LEGACY_API_TOKENS_ENABLED;
    expect(legacyApiTokensEnabled()).toBe(false);
  });

  it('sólo "true" exacto la enciende', () => {
    process.env.LEGACY_API_TOKENS_ENABLED = "true";
    expect(legacyApiTokensEnabled()).toBe(true);

    process.env.LEGACY_API_TOKENS_ENABLED = "false";
    expect(legacyApiTokensEnabled()).toBe(false);

    process.env.LEGACY_API_TOKENS_ENABLED = "TRUE";
    expect(legacyApiTokensEnabled()).toBe(false);

    process.env.LEGACY_API_TOKENS_ENABLED = "1";
    expect(legacyApiTokensEnabled()).toBe(false);
  });
});
