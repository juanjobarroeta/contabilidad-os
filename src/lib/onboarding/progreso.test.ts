import { describe, expect, it } from "vitest";
import { mezclarProgreso, PROGRESO_INICIAL, rutaManual, sanearAgregar } from "./progreso";

describe("onboarding flow recovery", () => {
  it("preserves later steps when a delayed preference save arrives", () => {
    expect(mezclarProgreso({ ...PROGRESO_INICIAL, paso: "historial", companyId: "a" }, { tono: "grano", paso: "personaje" }))
      .toMatchObject({ paso: "historial", companyId: "a", tono: "grano" });
  });
  it("keeps add-company references and sanitizes return destinations", () => {
    expect(sanearAgregar({ paso: "historial", companyId: "company-a", returnTo: "//external.test" }))
      .toEqual({ paso: "historial", companyId: "company-a", returnTo: null });
    expect(sanearAgregar(null)).toBeNull();
  });
  it("preserves internal return queries through manual entry", () => {
    const href = rutaManual(true, "/configuracion/empresas?tab=activas");
    const url = new URL(href, "https://app.test");
    expect(url.pathname).toBe("/onboarding/manual");
    expect(url.searchParams.get("from")).toBe("empresas");
    expect(url.searchParams.get("returnTo")).toBe("/configuracion/empresas?tab=activas");
    expect(rutaManual(false, "//external.test")).toBe("/onboarding/manual");
  });
});
