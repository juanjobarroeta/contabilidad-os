import { describe, it, expect } from "vitest";
import { linkWa, telefonoWa } from "./whatsapp";

describe("telefonoWa()", () => {
  it("10 dígitos MX → antepone 52", () => {
    expect(telefonoWa("222 123 4567")).toBe("522221234567");
    expect(telefonoWa("(55) 1234-5678")).toBe("525512345678");
  });

  it("ya con lada 52 se queda igual", () => {
    expect(telefonoWa("52 222 123 4567")).toBe("522221234567");
    expect(telefonoWa("+52 55 1234 5678")).toBe("525512345678");
  });

  it("formato viejo 521 + 10 dígitos → 52 + 10", () => {
    expect(telefonoWa("+521 222 123 4567")).toBe("522221234567");
  });

  it("internacionales plausibles pasan; basura no", () => {
    expect(telefonoWa("+1 305 555 0100")).toBe("13055550100");
    expect(telefonoWa("123")).toBeNull();
    expect(telefonoWa("sin teléfono")).toBeNull();
  });
});

describe("linkWa()", () => {
  it("arma el deep link con el mensaje urlencoded", () => {
    expect(linkWa("522221234567", "Hola ¿cómo vas?")).toBe(
      "https://wa.me/522221234567?text=Hola%20%C2%BFc%C3%B3mo%20vas%3F"
    );
  });
});
