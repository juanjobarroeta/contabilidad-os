import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import nextConfig from "../../../next.config";

afterEach(() => vi.unstubAllEnvs());

const baseline = {
  "content-security-policy": "base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'",
  "x-frame-options": "SAMEORIGIN",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function response(path: string, forwardedProto?: string) {
  return unstable_getResponseFromNextConfig({
    url: `http://localhost:3000${path}`,
    nextConfig,
    headers: forwardedProto ? { "x-forwarded-proto": forwardedProto } : {},
  });
}

describe("SEC-001 browser headers in the Sentry-wrapped Next configuration", () => {
  it("disables the framework identification header", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it.each([
    "/", "/login", "/impuestos", "/declaraciones", "/declaraciones/acuse/example",
    "/api/declaraciones/acuse/example", "/api/bancos/import-batches/example/pdf",
    "/api/facturas/example/file?format=pdf&token=invalid", "/api/facturas",
    "/api/auth/session", "/api/health", "/api/ready",
    "/_next/static/chunks/example.js", "/sw.js", "/manifest.webmanifest",
    "/does-not-exist",
  ])("covers %s, including APIs, downloads, assets and unknown paths", async (path) => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await response(path, "https");
    for (const [key, value] of Object.entries(baseline)) {
      expect(res.headers.get(key), key).toBe(value);
    }
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
    // Framing protection must not widen or replace the existing CORS policy.
    expect(res.headers.has("access-control-allow-origin")).toBe(false);
    expect(res.headers.has("access-control-allow-credentials")).toBe(false);
  });

  it("does not use config redirects, which discard headers on the real Next 15 server", () => {
    expect(nextConfig.redirects).toBeUndefined();
  });

  it.each([undefined, "http", "https,http", "not-https"])(
    "does not enable HSTS without an exact HTTPS proxy indication (%s)",
    async (proto) => {
      vi.stubEnv("NODE_ENV", "production");
      expect((await response("/login", proto)).headers.has("strict-transport-security")).toBe(false);
    },
  );

  it.each(["development", "test"])("never enables HSTS in %s", async (env) => {
    vi.stubEnv("NODE_ENV", env);
    const res = await response("/login", "https");
    expect(res.headers.has("strict-transport-security")).toBe(false);
    expect(res.headers.get("content-security-policy")).toBe(baseline["content-security-policy"]);
  });
});
