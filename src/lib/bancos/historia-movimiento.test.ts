import { describe, it, expect } from "vitest";
import { fusionarHistoria } from "./historia-movimiento";

const d = (iso: string) => new Date(iso);

const decision = {
  id: "d1",
  createdAt: d("2026-09-01T10:00:00Z"),
  motor: "auto-conciliar",
  actor: "motor",
  actorId: null,
  accion: "match",
  resultado: { invoiceId: "A" },
  razones: [{ regla: "conciliacion.sin-identidad", detalle: "Sólo coincidieron importe y fecha." }],
};

const bitacora = {
  id: "b1",
  createdAt: d("2026-09-03T12:00:00Z"),
  accion: "conciliacion.unmatch",
  actorEmail: "contador@despacho.mx",
  detalle: { monto: -30000 },
};

describe("fusionarHistoria", () => {
  it("mezcla motor y personas en una sola línea, lo más nuevo primero", () => {
    const eventos = fusionarHistoria([decision], [bitacora]);
    expect(eventos.map((e) => e.id)).toEqual(["b1", "d1"]);
    expect(eventos[0].origen).toBe("persona");
    expect(eventos[1].origen).toBe("motor");
  });

  it("traduce la acción de la bitácora a algo que se lee", () => {
    const [evento] = fusionarHistoria([], [bitacora]);
    expect(evento.titulo).toBe("Desconciliado a mano");
    expect(evento.autor).toBe("contador@despacho.mx");
  });

  it("conserva las razones del motor: son el porqué, no un adorno", () => {
    const [evento] = fusionarHistoria([decision], []);
    expect(evento.titulo).toBe("Conciliado por el motor");
    expect(evento.autor).toBe("auto-conciliar");
    expect(evento.razones[0].regla).toBe("conciliacion.sin-identidad");
  });

  it("una acción desconocida se muestra tal cual en vez de desaparecer", () => {
    const [evento] = fusionarHistoria([], [{ ...bitacora, accion: "bancos.algo-nuevo" }]);
    expect(evento.titulo).toBe("bancos.algo-nuevo");
  });

  it("una decisión tomada por una persona a través del motor NO se atribuye al motor", () => {
    const [evento] = fusionarHistoria(
      [{ ...decision, actor: "usuario", actorId: "user_7" }],
      [],
    );
    expect(evento.origen).toBe("persona");
    expect(evento.autor).toBe("user_7");
  });

  it("sin nada que contar devuelve una lista vacía, no un evento inventado", () => {
    expect(fusionarHistoria([], [])).toEqual([]);
  });
});
