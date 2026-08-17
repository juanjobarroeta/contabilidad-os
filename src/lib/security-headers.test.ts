import { describe, it, expect } from "vitest";
import { SECURITY_HEADERS, CSP_REPORT_ONLY } from "./security-headers";

// P0-5: si alguien quita un header de seguridad, esto se pone rojo ANTES del
// smoke de deploy (P2-3). La lista es un contrato, no una sugerencia.
describe("security headers (P0-5)", () => {
  const porNombre = new Map(SECURITY_HEADERS.map((h) => [h.key, h.value]));

  it.each([
    ["Strict-Transport-Security", /max-age=\d{7,}/],
    ["X-Content-Type-Options", /^nosniff$/],
    ["X-Frame-Options", /^DENY$/],
    ["Referrer-Policy", /strict-origin-when-cross-origin/],
    ["Permissions-Policy", /camera=\(\)/],
    ["Content-Security-Policy-Report-Only", /default-src 'self'/],
  ])("incluye %s", (nombre, patron) => {
    const valor = porNombre.get(nombre);
    expect(valor, `falta el header ${nombre}`).toBeDefined();
    expect(valor).toMatch(patron);
  });

  it("la CSP declara frame-ancestors, base-uri y a dónde reportar", () => {
    expect(CSP_REPORT_ONLY).toContain("frame-ancestors 'none'");
    expect(CSP_REPORT_ONLY).toContain("base-uri 'self'");
    expect(CSP_REPORT_ONLY).toContain("report-uri /api/csp-report");
    expect(CSP_REPORT_ONLY).toContain("object-src 'none'");
  });

  it("connect-src se queda en 'self': Sentry entra por el túnel /monitoring", () => {
    expect(CSP_REPORT_ONLY).toMatch(/connect-src 'self'(;|$)/);
  });
});
