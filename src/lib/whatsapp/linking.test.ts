import { describe, it, expect } from "vitest";
import {
  parseLinkCode,
  isLinkCodeValid,
  waMeLink,
  businessNumberE164,
} from "./linking";

describe("parseLinkCode", () => {
  it("reconoce «Vincular 483920» (con palabra clave explícita)", () => {
    expect(parseLinkCode("Vincular 483920")).toEqual({
      code: "483920",
      explicit: true,
    });
  });

  it("no distingue mayúsculas y tolera espacios extra", () => {
    expect(parseLinkCode("  vincular    483920  ")).toEqual({
      code: "483920",
      explicit: true,
    });
    expect(parseLinkCode("VINCULAR 483920")).toEqual({
      code: "483920",
      explicit: true,
    });
  });

  it("reconoce un código pelón de 6 dígitos (no explícito)", () => {
    expect(parseLinkCode("483920")).toEqual({ code: "483920", explicit: false });
    expect(parseLinkCode("  483920 ")).toEqual({ code: "483920", explicit: false });
  });

  it("rechaza basura y longitudes distintas de 6", () => {
    expect(parseLinkCode("hola")).toBeNull();
    expect(parseLinkCode("")).toBeNull();
    expect(parseLinkCode("12345")).toBeNull(); // 5 dígitos
    expect(parseLinkCode("1234567")).toBeNull(); // 7 dígitos
    expect(parseLinkCode("Vincular")).toBeNull(); // sin código
    expect(parseLinkCode("Vincular abc")).toBeNull(); // no numérico
    expect(parseLinkCode("Vincular 12345")).toBeNull(); // 5 dígitos
    expect(parseLinkCode("mi código es 483920")).toBeNull(); // texto de más
  });
});

describe("isLinkCodeValid", () => {
  const now = new Date("2026-07-04T12:00:00Z");

  it("es válido si no está usado y no ha expirado", () => {
    expect(
      isLinkCodeValid(
        { usedAt: null, expiresAt: new Date("2026-07-04T12:05:00Z") },
        now
      )
    ).toBe(true);
  });

  it("es inválido si ya se usó", () => {
    expect(
      isLinkCodeValid(
        { usedAt: new Date("2026-07-04T11:59:00Z"), expiresAt: new Date("2026-07-04T12:05:00Z") },
        now
      )
    ).toBe(false);
  });

  it("es inválido si expiró", () => {
    expect(
      isLinkCodeValid(
        { usedAt: null, expiresAt: new Date("2026-07-04T11:55:00Z") },
        now
      )
    ).toBe(false);
  });

  it("es inválido justo al instante de expiración (borde)", () => {
    expect(
      isLinkCodeValid({ usedAt: null, expiresAt: now }, now)
    ).toBe(false);
  });

  it("es inválido si no hay registro", () => {
    expect(isLinkCodeValid(null, now)).toBe(false);
  });
});

describe("waMeLink", () => {
  it("construye el enlace desde TWILIO_WHATSAPP_FROM sin «whatsapp:» ni «+»", () => {
    expect(waMeLink("whatsapp:+14155238886", "483920")).toBe(
      "https://wa.me/14155238886?text=Vincular%20483920"
    );
  });

  it("tolera un número sin prefijo whatsapp:", () => {
    expect(waMeLink("+525512345678", "000123")).toBe(
      "https://wa.me/525512345678?text=Vincular%20000123"
    );
  });
});

describe("businessNumberE164", () => {
  it("quita el prefijo whatsapp: y conserva el E.164", () => {
    expect(businessNumberE164("whatsapp:+14155238886")).toBe("+14155238886");
    expect(businessNumberE164("+525512345678")).toBe("+525512345678");
  });
});
