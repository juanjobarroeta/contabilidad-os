import { describe, expect, it } from "vitest";
import { ordenarTareas, transicionValida, urgencia, type Tarea } from "./tareas";
import { resumenDeVersion, seccionesCambiadas } from "./versiones";
import { camposCambiados, normalizarDatosCliente, type Cliente } from "./clientes";
import { frase } from "./bitacora";

const tarea = (p: Partial<Tarea>): Tarea => ({
  id: p.id ?? "t", casoId: "c", titulo: p.titulo ?? "x", detalle: null, estado: p.estado ?? "por_hacer",
  prioridad: p.prioridad ?? "normal", vence: p.vence ?? null, asignadoUserId: null, creadaPorUserId: "u",
  documentoId: null, origen: "manual", hechaAt: null, createdAt: p.createdAt ?? new Date("2026-01-01"), updatedAt: new Date(),
});

describe("tareas: urgencia y orden", () => {
  const ahora = new Date("2026-09-14T12:00:00Z");
  it("vencida, hoy, próxima, lejana, sin fecha y cerrada", () => {
    expect(urgencia(tarea({ vence: new Date("2026-09-10T00:00:00Z") }), ahora)).toEqual({ estado: "vencida", dias: -4 });
    expect(urgencia(tarea({ vence: new Date("2026-09-14T23:00:00Z") }), ahora)).toEqual({ estado: "hoy", dias: 0 });
    expect(urgencia(tarea({ vence: new Date("2026-09-16T00:00:00Z") }), ahora).estado).toBe("proxima");
    expect(urgencia(tarea({ vence: new Date("2026-10-01T00:00:00Z") }), ahora).estado).toBe("lejana");
    expect(urgencia(tarea({}), ahora).estado).toBe("sin_fecha");
    expect(urgencia(tarea({ estado: "hecha", vence: new Date("2026-01-01") }), ahora).estado).toBe("cerrada");
  });
  it("primero lo que urge; lo cerrado al final; la prioridad desempata", () => {
    const t = ordenarTareas([
      tarea({ id: "sin", titulo: "sin fecha" }),
      tarea({ id: "hecha", estado: "hecha", vence: new Date("2026-09-01") }),
      tarea({ id: "vencida", vence: new Date("2026-09-10") }),
      tarea({ id: "hoy", vence: new Date("2026-09-14") }),
      tarea({ id: "sin-alta", titulo: "sin fecha pero alta", prioridad: "alta" }),
    ], ahora);
    expect(t.map((x) => x.id)).toEqual(["vencida", "hoy", "sin-alta", "sin", "hecha"]);
  });
  it("una tarea cerrada sólo se reabre a por_hacer o en_curso", () => {
    expect(transicionValida("por_hacer", "hecha")).toBe(true);
    expect(transicionValida("hecha", "por_hacer")).toBe(true);
    expect(transicionValida("hecha", "en_revision")).toBe(false);
    expect(transicionValida("cancelada", "en_curso")).toBe(true);
  });
});

describe("versiones: qué cambió", () => {
  const antes = [{ n: 1, titulo: "PRIMERA.- OBJETO", markdown: "a" }, { n: 2, titulo: "SEGUNDA.- RENTA", markdown: "b" }, { n: 3, titulo: "TERCERA.- PLAZO", markdown: "c" }];
  it("agregada, editada y eliminada, por número de sección", () => {
    const despues = [{ n: 1, titulo: "PRIMERA.- OBJETO", markdown: "a" }, { n: 2, titulo: "SEGUNDA.- RENTA", markdown: "b2" }, { n: 4, titulo: "CUARTA.- DEPÓSITO", markdown: "d" }];
    expect(seccionesCambiadas(antes, despues)).toEqual([
      { n: 2, titulo: "SEGUNDA.- RENTA", cambio: "editada" },
      { n: 3, titulo: "TERCERA.- PLAZO", cambio: "eliminada" },
      { n: 4, titulo: "CUARTA.- DEPÓSITO", cambio: "agregada" },
    ]);
    expect(seccionesCambiadas(antes, antes)).toEqual([]);
    expect(seccionesCambiadas(null, null)).toEqual([]);
  });
  it("cambiar sólo el título cuenta como edición", () => {
    expect(seccionesCambiadas(antes, [{ n: 1, titulo: "PRIMERA.- DEL OBJETO", markdown: "a" }])[0]).toMatchObject({ n: 1, cambio: "editada" });
  });
  it("el resumen nombra las secciones y no se alarga", () => {
    expect(resumenDeVersion(3, [{ titulo: "SEGUNDA.- RENTA", cambio: "editada" }], "el cliente pidió INPC")).toBe("guardó la versión 3: 1 sección (SEGUNDA.- RENTA) — el cliente pidió INPC");
    const muchas = [1, 2, 3, 4, 5].map((n) => ({ titulo: `S${n}`, cambio: "editada" }));
    expect(resumenDeVersion(2, muchas)).toContain("y 2 más");
    expect(resumenDeVersion(1, [])).toBe("guardó la versión 1");
  });
});

describe("clientes: normalización y diff", () => {
  it("limpia objetos del modelo, valida RFC/CURP y normaliza el nombre", () => {
    const n = normalizarDatosCliente({ nombre: "Inmobiliaria Cholula, S.A. de C.V.", rfc: "ich120101ab1", curp: "no-es-curp", representante: { nombre: "Jorge Luna", rol: "apoderado" } as unknown as string, tipoPersona: "moral" });
    expect(n.rfc).toBe("ICH120101AB1");
    expect(n.curp).toBeNull();
    expect(n.nombreNormalizado).toBe("inmobiliaria cholula");
    expect(n.representante).toBe("Jorge Luna (apoderado)");
  });
  it("camposCambiados sólo lista lo que de verdad cambió", () => {
    const base: Cliente = { id: "c", tipoPersona: "moral", nombre: "A", rfc: null, curp: null, domicilio: null, representante: null, email: null, telefono: null, notas: null, verificado: false, createdAt: new Date(), updatedAt: new Date() };
    expect(camposCambiados(base, { ...base })).toEqual([]);
    expect(camposCambiados(base, { ...base, domicilio: "Av. Reforma 500", verificado: true })).toEqual(["domicilio", "verificado"]);
  });
});

describe("bitácora: frase legible", () => {
  it("usa el nombre del actor, o dice quién fue por su tipo", () => {
    expect(frase({ accion: "tarea.creada", resumen: "agregó el pendiente «x»", actorTipo: "abogado", actorNombre: "Ana Torres" })).toBe("Ana Torres: agregó el pendiente «x»");
    expect(frase({ accion: "documento.version", resumen: "guardó la versión 2", actorTipo: "copiloto", actorNombre: null })).toBe("El copiloto: guardó la versión 2");
    expect(frase({ accion: "caso.creado", resumen: "creó el caso", actorTipo: "abogado", actorNombre: null }, "Yesenia")).toBe("Yesenia: creó el caso");
  });
});
