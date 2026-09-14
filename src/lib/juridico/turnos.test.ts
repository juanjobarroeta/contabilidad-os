import { describe, expect, it } from "vitest";
import { INSTANCIA, elegirHuerfanos, iniciarTurno, respuestaSse, respuestaSseDesdeAlmacen, turnoEnCurso, turnoReciente, type AlmacenTurnos, type CheckpointTurno, type EventoTurno } from "./turnos";

async function leerTodo(res: Response): Promise<EventoTurno[]> {
  const texto = await res.text();
  return texto
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as EventoTurno);
}

function almacenFalso() {
  const llamadas: { op: string; args: unknown[] }[] = [];
  const a: AlmacenTurnos = {
    async crear(t) {
      llamadas.push({ op: "crear", args: [t] });
    },
    async agregarEventos(id, eventos) {
      llamadas.push({ op: "eventos", args: [id, eventos] });
    },
    async latido(id) {
      llamadas.push({ op: "latido", args: [id] });
    },
    async guardarCheckpoint(id, cp: CheckpointTurno) {
      llamadas.push({ op: "checkpoint", args: [id, cp] });
    },
    async terminar(id, estado, error) {
      llamadas.push({ op: "terminar", args: [id, estado, error] });
    },
  };
  return { a, llamadas };
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
    expect((ev[0] as unknown as { estado: string }).estado).toBe("terminado");
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

describe("turnos persistidos", () => {
  it("los deltas de texto se guardan en lote, las herramientas al momento, y al final se marca terminado en orden", async () => {
    const { a, llamadas } = almacenFalso();
    const t = iniciarTurno({
      id: "t-1",
      conversacionId: "c4",
      userId: "u1",
      almacen: a,
      correr: async (emitir) => {
        emitir({ type: "conversation", id: "c4" });
        emitir({ type: "text", text: "a" });
        emitir({ type: "text", text: "b" });
        emitir({ type: "tool_start", tool: "get_articulo" });
        await new Promise((r) => setTimeout(r, 5));
        emitir({ type: "text", text: "c" });
        emitir({ type: "done" });
      },
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(t.estado).toBe("terminado");
    const ops = llamadas.map((l) => l.op);
    expect(ops[ops.length - 1]).toBe("terminar");
    expect(llamadas[llamadas.length - 1].args[1]).toBe("terminado");
    // Todo lo emitido llegó al almacén, en orden y sin repetir.
    const guardados = llamadas.filter((l) => l.op === "eventos").flatMap((l) => l.args[1] as EventoTurno[]);
    expect(guardados.map((e) => e.type)).toEqual(["conversation", "text", "text", "tool_start", "text", "done"]);
    // Un evento que no es texto vacía el lote al momento: «conversation» solo, y
    // luego los dos deltas de texto junto con la herramienta (sin esperar al timer).
    const lotes = llamadas.filter((l) => l.op === "eventos").map((l) => (l.args[1] as EventoTurno[]).map((e) => e.type));
    expect(lotes[0]).toEqual(["conversation"]);
    expect(lotes[1]).toEqual(["text", "text", "tool_start"]);
  });

  it("un turno reanudado precarga los eventos guardados para que «desde=N» siga valiendo, y un error se marca como tal", async () => {
    const { a, llamadas } = almacenFalso();
    const previos: EventoTurno[] = [{ type: "conversation", id: "c5" }, { type: "text", text: "hola" }];
    const t = iniciarTurno({
      id: "t-2",
      conversacionId: "c5",
      userId: "u1",
      almacen: a,
      eventosPrevios: previos,
      correr: async (emitir) => {
        emitir({ type: "replace", text: "" });
        emitir({ type: "error", error: "se cayó" });
        throw new Error("se cayó");
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    const ev = await leerTodo(respuestaSse(t, 2));
    expect(ev.map((e) => e.type)).toEqual(["turno", "replace", "error"]);
    expect(llamadas[llamadas.length - 1].args.slice(1)).toEqual(["error", "se cayó"]);
  });

  it("elegirHuerfanos: sólo los que nadie late, de otro proceso, sin turno en memoria", () => {
    const ahora = Date.now();
    const filas = [
      { id: "a", conversacionId: "x1", latido: new Date(ahora - 60_000), instancia: "otro" },
      { id: "b", conversacionId: "x2", latido: new Date(ahora - 10_000), instancia: "otro" },
      { id: "c", conversacionId: "x3", latido: new Date(ahora - 60_000), instancia: INSTANCIA },
    ];
    expect(elegirHuerfanos(filas, ahora, 45_000).map((f) => f.id)).toEqual(["a"]);
  });

  it("la vista desde el almacén sondea hasta que el turno termina y no repite eventos", async () => {
    let lecturas = 0;
    const lector = {
      async leer() {
        lecturas++;
        return lecturas < 3
          ? { estado: "en_curso" as const, eventos: [{ type: "conversation", id: "c6" }, { type: "text", text: "a" }] }
          : { estado: "terminado" as const, eventos: [{ type: "conversation", id: "c6" }, { type: "text", text: "a" }, { type: "done" }] };
      },
    };
    const ev = await leerTodo(respuestaSseDesdeAlmacen(lector, "t-3", 1, { intervaloMs: 5 }));
    expect(ev[0]).toMatchObject({ type: "turno", origen: "almacen", estado: "en_curso" });
    expect(ev.slice(1).map((e) => e.type)).toEqual(["text", "done"]);
    expect(lecturas).toBe(3);
  });
});
