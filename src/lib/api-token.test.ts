import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { decodeJwt } from "jose";

process.env.AUTH_SECRET = "secreto-de-prueba-para-tokens-api";

import { SignJWT } from "jose";

import {
  signApiToken,
  signClubMemberToken,
  verifyApiToken,
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

describe("tokens legados de 7 días — retirados", () => {
  it("verifyApiToken RECHAZA un token con forma legada (sin jti) aunque la firma sea válida", async () => {
    // Forma legada firmada con el mismo secreto/issuer/audience — antes del
    // retiro habría verificado; hoy debe morir en el requisito de jti.
    const legado = await new SignJWT({ email: usuario.email, name: usuario.name })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(usuario.sub)
      .setIssuedAt()
      .setIssuer("contabilidad-os")
      .setAudience("contabilidad-os:api")
      .setExpirationTime("7d")
      .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));

    await expect(verifyApiToken(legado)).rejects.toThrow(/jti/);
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
