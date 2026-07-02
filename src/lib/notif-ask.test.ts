import { describe, it, expect } from "vitest";
import { conParametroAsk, leerAskParam } from "./notif-ask";

describe("conParametroAsk", () => {
  it("anexa ?ask a una URL sin query", () => {
    expect(conParametroAsk("/pendientes", "abc")).toBe("/pendientes?ask=abc");
  });

  it("usa & cuando ya hay query string", () => {
    expect(conParametroAsk("/estado-cuenta?company=1", "abc")).toBe(
      "/estado-cuenta?company=1&ask=abc",
    );
  });

  it("reinserta el hash al final (sin query previa)", () => {
    expect(conParametroAsk("/x#seccion", "abc")).toBe("/x?ask=abc#seccion");
  });

  it("reinserta el hash al final (con query previa)", () => {
    expect(conParametroAsk("/x?a=1#seccion", "abc")).toBe("/x?a=1&ask=abc#seccion");
  });

  it("codifica dedupeKeys con caracteres especiales", () => {
    expect(conParametroAsk("/x", "nomina 2026/07 &b")).toBe(
      "/x?ask=nomina%202026%2F07%20%26b",
    );
  });
});

describe("leerAskParam", () => {
  it("devuelve null cuando no hay ask", () => {
    expect(leerAskParam("?a=1&b=2")).toBeNull();
    expect(leerAskParam("")).toBeNull();
  });

  it("lee ask con el ? inicial", () => {
    expect(leerAskParam("?ask=abc")).toBe("abc");
  });

  it("lee ask sin el ? inicial", () => {
    expect(leerAskParam("ask=abc")).toBe("abc");
  });

  it("decodifica el valor", () => {
    expect(leerAskParam("?ask=nomina%202026%2F07%20%26b")).toBe("nomina 2026/07 &b");
  });

  it("round-trip: leerAskParam recupera lo que conParametroAsk escribió", () => {
    const key = "nomina 2026/07 &b#x";
    const url = conParametroAsk("/x?a=1", key);
    const search = url.slice(url.indexOf("?"));
    expect(leerAskParam(search)).toBe(key);
  });
});
