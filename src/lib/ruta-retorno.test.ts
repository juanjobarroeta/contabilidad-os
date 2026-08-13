import { describe, expect, it } from "vitest";
import { rutaRetornoSegura } from "./ruta-retorno";

describe("rutaRetornoSegura", () => {
  it("acepta rutas internas normales", () => {
    expect(rutaRetornoSegura("/dashboard")).toBe("/dashboard");
    // El caso que motivó todo: volver a la página de aceptación de invitación.
    expect(rutaRetornoSegura("/invitacion/abc123")).toBe("/invitacion/abc123");
    expect(rutaRetornoSegura("/facturas?q=uuid")).toBe("/facturas?q=uuid");
  });

  it("sin valor devuelve null (el caller pone su default)", () => {
    expect(rutaRetornoSegura(null)).toBeNull();
    expect(rutaRetornoSegura(undefined)).toBeNull();
    expect(rutaRetornoSegura("")).toBeNull();
    expect(rutaRetornoSegura("   ")).toBeNull();
  });

  it("rechaza URLs absolutas: esto sería un open redirect en el login", () => {
    // La página de login es justo a donde un phisher manda a la gente después
    // de robar la contraseña — un callbackUrl abierto le da el viaje de vuelta.
    expect(rutaRetornoSegura("https://evil.com/login")).toBeNull();
    expect(rutaRetornoSegura("http://evil.com")).toBeNull();
    expect(rutaRetornoSegura("javascript:alert(1)")).toBeNull();
  });

  it("rechaza protocol-relative: //evil.com se resuelve como https://evil.com", () => {
    expect(rutaRetornoSegura("//evil.com")).toBeNull();
    expect(rutaRetornoSegura("//evil.com/invitacion")).toBeNull();
  });

  it("rechaza /\\evil.com: los navegadores tratan \\ como / al resolver", () => {
    expect(rutaRetornoSegura("/\\evil.com")).toBeNull();
  });

  it("rechaza controles y saltos de línea (header/URL splitting)", () => {
    expect(rutaRetornoSegura("/dash\nboard")).toBeNull();
    expect(rutaRetornoSegura("/dash\rboard")).toBeNull();
    expect(rutaRetornoSegura("/dash\x00board")).toBeNull();
  });

  it("recorta espacios alrededor pero no altera la ruta", () => {
    expect(rutaRetornoSegura("  /dashboard  ")).toBe("/dashboard");
  });
});
