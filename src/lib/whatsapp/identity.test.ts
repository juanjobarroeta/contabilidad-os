import { describe, it, expect } from "vitest";
import {
  normalizePhone,
  phoneVariants,
  matchCompanyByName,
  parseCompanySelection,
  type AccessibleCompany,
} from "./identity";

const CARTERA: AccessibleCompany[] = [
  { id: "c1", razonSocial: "Reyes Huerta Cholula SA de CV" },
  { id: "c2", razonSocial: "ZionX Soluciones SAPI de CV" },
  { id: "c3", razonSocial: "Comercializadora del Bajío" },
];

describe("normalizePhone", () => {
  it("agrega el + y limpia espacios/guiones/paréntesis", () => {
    expect(normalizePhone("52 (55) 1234-5678")).toBe("+525512345678");
    expect(normalizePhone("+52 55 1234 5678")).toBe("+525512345678");
  });

  it("canonicaliza el móvil mexicano +521########## → +52##########", () => {
    // WhatsApp entrega el From de un móvil MX con el '1' después del 52.
    expect(normalizePhone("+5215512345678")).toBe("+525512345678");
    expect(normalizePhone("whatsapp:+5215512345678".replace("whatsapp:", ""))).toBe("+525512345678");
  });

  it("canonicaliza el móvil MX con '1' sin el '+': 521########## → +52##########", () => {
    expect(normalizePhone("5215512345678")).toBe("+525512345678");
  });

  it("canonicaliza el nacional con lada 52 sin '+': 52########## → +52##########", () => {
    expect(normalizePhone("525512345678")).toBe("+525512345678");
  });

  it("asume México para 10 dígitos pelones (capturados sin lada)", () => {
    expect(normalizePhone("5512345678")).toBe("+525512345678");
    expect(normalizePhone("55 1234 5678")).toBe("+525512345678");
    expect(normalizePhone("(55) 1234-5678")).toBe("+525512345678");
  });

  it("no toca números no-MX ni el 1 que no es prefijo de móvil MX", () => {
    expect(normalizePhone("+14155238886")).toBe("+14155238886"); // US
    expect(normalizePhone("+525512345678")).toBe("+525512345678"); // ya canónico
    // 11 dígitos con '+' que no es MX: se respeta tal cual (no se asume México).
    expect(normalizePhone("+14155238886")).toBe("+14155238886");
  });
});

describe("phoneVariants", () => {
  it("para México devuelve la canónica y la variante con 1 (matchea enlaces previos)", () => {
    expect(phoneVariants("+5215512345678").sort()).toEqual(
      ["+521 5512345678".replace(" ", ""), "+525512345678"].sort()
    );
    expect(phoneVariants("+525512345678").sort()).toEqual(
      ["+5215512345678", "+525512345678"].sort()
    );
  });

  it("para otros países sólo la canónica", () => {
    expect(phoneVariants("+14155238886")).toEqual(["+14155238886"]);
  });
});

describe("matchCompanyByName", () => {
  it("encuentra por nombre parcial, insensible a mayúsculas y acentos", () => {
    expect(matchCompanyByName("y de reyes huerta?", CARTERA)?.id).toBe("c1");
    expect(matchCompanyByName("BAJIO", CARTERA)?.id).toBe("c3"); // sin acento
    expect(matchCompanyByName("zionx", CARTERA)?.id).toBe("c2");
  });

  it("ignora marcadores legales compartidos (SA de CV) — no cambia de empresa", () => {
    expect(matchCompanyByName("SA de CV", CARTERA)).toBeNull();
    expect(matchCompanyByName("de cv", CARTERA)).toBeNull();
    expect(matchCompanyByName("empresa que no existe", CARTERA)).toBeNull();
  });

  it("es null si el mensaje alude a más de una empresa (ambiguo)", () => {
    // "reyes" (c1) y "zionx" (c2) presentes a la vez → ambiguo → null.
    expect(matchCompanyByName("compara reyes con zionx", CARTERA)).toBeNull();
  });
});

describe("parseCompanySelection", () => {
  it("interpreta un número como selección 1-based del menú", () => {
    expect(parseCompanySelection("1", CARTERA)?.id).toBe("c1");
    expect(parseCompanySelection("3", CARTERA)?.id).toBe("c3");
    expect(parseCompanySelection("9", CARTERA)).toBeNull(); // fuera de rango
  });

  it("acepta el nombre de la empresa como selección", () => {
    expect(parseCompanySelection("ZionX", CARTERA)?.id).toBe("c2");
  });

  it("devuelve null si no es número ni nombre reconocible", () => {
    expect(parseCompanySelection("hola", CARTERA)).toBeNull();
  });
});
