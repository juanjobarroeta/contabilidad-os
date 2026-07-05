import { describe, it, expect } from "vitest";
import { decideChatUserDaily } from "./rate-limit";

describe("decideChatUserDaily — tope diario por usuario del chat in-app", () => {
  it("permite por debajo del tope", () => {
    expect(decideChatUserDaily({ dailyCount: 10, limit: 50 }).allowed).toBe(true);
  });

  it("bloquea al alcanzar el tope", () => {
    const d = decideChatUserDaily({ dailyCount: 50, limit: 50 });
    expect(d.allowed).toBe(false);
    expect(d.mensaje).toMatch(/límite de mensajes por hoy/i);
  });

  it("bloquea por encima del tope", () => {
    expect(decideChatUserDaily({ dailyCount: 120, limit: 50 }).allowed).toBe(false);
  });

  it("permite justo por debajo (tope - 1)", () => {
    expect(decideChatUserDaily({ dailyCount: 49, limit: 50 }).allowed).toBe(true);
  });

  it("un tope de 0 bloquea siempre", () => {
    const d = decideChatUserDaily({ dailyCount: 0, limit: 0 });
    expect(d.allowed).toBe(false);
    expect(d.mensaje).toMatch(/límite de mensajes por hoy/i);
  });
});
