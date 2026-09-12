import { describe, expect, it } from "vitest";
import { iniciarTurno, respuestaSse, turnoEnCurso, turnoReciente, type EventoTurno } from "./turnos";

async function leerTodo(res: Response): Promise<EventoTurno[]> {
  const texto = await res.text();
  return texto
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as EventoTurno);
}

describe("turnos reanudables", () => {
  it("el turno corre aunque nadie escuche, guarda sus eventos y una vista tardía los reproduce", async () => {
    let liberar!: () => void;
    const espera = new Promise<void>((r) => (liberar = r));
    const t = iniciarTurno({
      conversacionId: "c1",
      userId: "u1",
      correr: async (emitir) => {
        emitir({ type: "conversation", id: "c1" });
        emitir({ type: "text", text: "Hola " });
        await espera;
        emitir({ type: "text", text: "mundo" });
        emitir({ type: "done" });
      },
    });
    expect(turnoEnCurso("c1")?.id).toBe(t.id);
    await new Promise((r) => setTimeout(r, 5));
    expect(t.eventos.map((e) => e.type)).toEqual(["conversation", "text"]);
    // Un cliente que llega tarde: reproduce lo anterior y sigue en vivo hasta el final.
    const vista = respuestaSse(t);
    liberar();
    const ev = await leerTodo(vista);
    expect(ev[0].type).toBe("turno");
    expect(ev.slice(1).map((e) => e.type)).toEqual(["conversation", "text", "text", "done"]);
    expect(turnoEnCurso("c1")).toBeNull();
    expect(turnoReciente("c1")?.estado).toBe("terminado");
  });

  it("reanudar desde N salta lo ya visto; un turno terminado cierra de inmediato", async () => {
    const t = iniciarTurno({
      conversacionId: "c2",
      userId: "u1",
      correr: async (emitir) => {
        emitir({ type: "text", text: "a" });
        emitir({ type: "text", text: "b" });
        emitir({ type: "done" });
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    const ev = await leerTodo(respuestaSse(t, 2));
    expect(ev.map((e) => e.type)).toEqual(["turno", "done"]);
    expect((ev[0] as { estado: string }).estado).toBe("terminado");
  });

  it("un turno que falla queda en error y no bloquea el siguiente; dos a la vez en la misma conversación no", async () => {
    const t = iniciarTurno({
      conversacionId: "c3",
      userId: "u1",
      correr: async (emitir) => {
        emitir({ type: "error", error: "boom" });
        throw new Error("boom");
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(t.estado).toBe("error");
    const t2 = iniciarTurno({ conversacionId: "c3", userId: "u1", correr: async () => new Promise((r) => setTimeout(r, 30)) });
    expect(() => iniciarTurno({ conversacionId: "c3", userId: "u1", correr: async () => {} })).toThrow(/en curso/);
    await new Promise((r) => setTimeout(r, 40));
    expect(t2.estado).toBe("terminado");
  });
});
