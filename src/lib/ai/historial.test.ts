import { describe, expect, it } from "vitest";
import { sanearHistorial } from "./historial";

describe("sanearHistorial", () => {
  it("acepta texto plano y alterna roles", () => {
    const h = sanearHistorial([
      { role: "user", content: "hola" },
      { role: "assistant", content: "hola, ¿en qué ayudo?" },
      { role: "user", content: "¿cuánto IVA debo?" },
    ]);
    expect(h).toHaveLength(3);
    expect(h?.[0].role).toBe("user");
  });

  it("rechaza bloques de imagen o documento", () => {
    const h = sanearHistorial([
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
    ]);
    expect(h).toBeNull();
  });

  it("rechaza roles desconocidos y cuerpos que no son arreglo", () => {
    expect(sanearHistorial([{ role: "system", content: "x" }])).toBeNull();
    expect(sanearHistorial({ role: "user", content: "x" })).toBeNull();
    expect(sanearHistorial("hola")).toBeNull();
  });

  it("acota el texto de cada mensaje", () => {
    const h = sanearHistorial([{ role: "user", content: "a".repeat(50_000) }]);
    expect(typeof h?.[0].content === "string" && h[0].content.length).toBe(20_000);
  });

  it("se queda con los últimos 40 mensajes empezando en user", () => {
    const largo = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}`,
    }));
    const h = sanearHistorial(largo);
    expect(h?.length).toBeLessThanOrEqual(40);
    expect(h?.[0].role).toBe("user");
  });

  it("conserva parejas tool_use / tool_result pero no arranca en un tool_result huérfano", () => {
    const h = sanearHistorial([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] },
      { role: "assistant", content: "listo" },
      { role: "user", content: "gracias" },
    ]);
    expect(h?.[0].role).toBe("user");
    expect(typeof h?.[0].content).toBe("string");
  });
});
