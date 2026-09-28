import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, middleware } from "@/middleware";
import { legacyWorkspaceRedirect } from "./legacy-redirects";

describe("legacy workspace redirects retain their routing contract", () => {
  it.each([
    ["/declaracion", "/impuestos", "del-mes"],
    ["/declaraciones", "/impuestos", "historial"],
    ["/declaracion-anual", "/impuestos", "anual"],
    ["/impuestos/detalle", "/impuestos", "del-mes"],
    ["/impuestos/cierre", "/impuestos", "del-mes"],
    ["/bancos/detalle", "/bancos", "incoming"],
    ["/activos", "/contabilidad", "activo-fijo"],
    ["/nomina/detalle", "/nomina", "corridas"],
  ])("redirects %s without changing period, status or CORS", (source, path, tab) => {
    const url = `https://hub.example${source}?month=9&year=2026&tag=a&tag=b&tab=incoming`;
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    const res = middleware(new NextRequest(url, { headers: { origin: "https://satellite.example" } }));
    expect(res.status).toBe(307);
    const target = new URL(res.headers.get("location")!);
    expect(target.origin).toBe("https://hub.example");
    expect(target.pathname).toBe(path);
    expect(target.searchParams.get("tab")).toBe(tab);
    expect(target.searchParams.get("month")).toBe("9");
    expect(target.searchParams.get("year")).toBe("2026");
    expect(target.searchParams.getAll("tag")).toEqual(["a", "b"]);
    expect(res.headers.has("access-control-allow-origin")).toBe(false);
  });

  it.each([
    "/login", "/api/auth/session", "/api/auth/callback/credentials",
    "/declaraciones/acuse/example", "/impuestos/papeles", "/nomina/cockpit",
    "/declaraciones-extra", "/activos/unknown", "/toString", "/constructor",
  ])("does not widen middleware or redirect %s", (path) => {
    const url = `https://hub.example${path}`;
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
    expect(legacyWorkspaceRedirect(new NextRequest(url))).toBeNull();
  });

  it.each(["/api/facturas", "/api/bancos/import-batches/example/pdf", "/api/auth/token/refresh", "/api/hospital/pacientes"])(
    "retains the existing API matcher without redirecting %s", (path) => {
      const url = `https://hub.example${path}`;
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
      expect(legacyWorkspaceRedirect(new NextRequest(url))).toBeNull();
    },
  );
});
