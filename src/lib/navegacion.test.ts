import { describe, it, expect } from "vitest";
import { rutaInternaSegura } from "./navegacion";

describe("rutaInternaSegura", () => {
  it("acepta rutas internas", () => {
    expect(rutaInternaSegura("/opiniones", "/x")).toBe("/opiniones");
    expect(rutaInternaSegura("/nomina?tab=cumplimiento", "/x")).toBe("/nomina?tab=cumplimiento");
  });

  it("toma el primer valor cuando el query trae el param repetido", () => {
    expect(rutaInternaSegura(["/impuestos", "/otro"], "/x")).toBe("/impuestos");
  });

  it("rechaza orígenes ajenos — incluidas las protocol-relative", () => {
    expect(rutaInternaSegura("https://evil.com", "/x")).toBe("/x");
    expect(rutaInternaSegura("//evil.com", "/x")).toBe("/x");
    expect(rutaInternaSegura("/\\evil.com", "/x")).toBe("/x");
    expect(rutaInternaSegura("javascript:alert(1)", "/x")).toBe("/x");
  });

  it("rechaza vacío, ausente y caracteres de control", () => {
    expect(rutaInternaSegura(undefined, "/x")).toBe("/x");
    expect(rutaInternaSegura(null, "/x")).toBe("/x");
    expect(rutaInternaSegura("", "/x")).toBe("/x");
    expect(rutaInternaSegura("/ruta\nevil", "/x")).toBe("/x");
  });
});
