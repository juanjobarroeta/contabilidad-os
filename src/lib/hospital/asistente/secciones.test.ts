import { describe, expect, it } from "vitest";
import { PLANTILLAS_NOTA, errorSecciones } from "../notas";
import { mapearSecciones } from "./secciones";
import { describirPlantilla } from "./prompts";

describe("mapearSecciones", () => {
  it("conserva sólo las claves de la plantilla y reporta las obligatorias que faltan", () => {
    const r = mapearSecciones("EVOLUCION", { subjetivo: "Sin dolor", objetivo: "Herida limpia", plan: "Alta mañana", inventada: "x", estudios: "" });
    expect(r.secciones).toEqual({ subjetivo: "Sin dolor", objetivo: "Herida limpia", plan: "Alta mañana" });
    expect(r.faltantes).toEqual(["analisis"]);
    expect(r.descartadas).toEqual(["inventada"]);
    expect(r.advertencias.join("\n")).toMatch(/Faltan secciones obligatorias .*Análisis/);
    expect(r.advertencias.join("\n")).toMatch(/se descartaron: inventada/);
  });

  it("una nota completa pasa errorSecciones tal cual", () => {
    const r = mapearSecciones("EVOLUCION", { subjetivo: "a", objetivo: "b", analisis: "c", plan: "d", pronostico: "Bueno" });
    expect(r.faltantes).toEqual([]);
    expect(errorSecciones("EVOLUCION", r.secciones)).toBeNull();
  });

  it("convierte las escalas a entero y descarta lo que no cabe en el rango", () => {
    const base = { medicamentos: "Propofol", duracion: "2 h", incidentes: "Ninguno", liquidos: "1000 ml", estadoEgresoQuirofano: "Estable", plan: "Recuperación" };
    expect(mapearSecciones("POSTANESTESICA", { ...base, aldrete: "9" }).secciones.aldrete).toBe(9);
    expect(mapearSecciones("POSTANESTESICA", { ...base, aldrete: "9/10" }).secciones.aldrete).toBe(9);
    expect(mapearSecciones("POSTANESTESICA", { ...base, aldrete: 9 }).secciones.aldrete).toBe(9);
    const fuera = mapearSecciones("POSTANESTESICA", { ...base, aldrete: 11 });
    expect(fuera.secciones.aldrete).toBeUndefined();
    expect(fuera.faltantes).toContain("aldrete");
    expect(fuera.advertencias.join("\n")).toMatch(/Aldrete.*fuera del rango 0-10/);
    const texto = mapearSecciones("POSTANESTESICA", { ...base, aldrete: "nueve" });
    expect(texto.secciones.aldrete).toBeUndefined();
    expect(texto.advertencias.join("\n")).toMatch(/«nueve», que no es un entero/);
    expect(mapearSecciones("HOJA_URGENCIAS", { triageNivel: "3" }).secciones.triageNivel).toBe(3);
    expect(mapearSecciones("HOJA_URGENCIAS", { triageNivel: 0 }).secciones.triageNivel).toBeUndefined();
  });

  it("normaliza el ASA y avisa si no es una clase", () => {
    const base = { evaluacionClinica: "…", tipoAnestesia: "General", planAnestesico: "…" };
    expect(mapearSecciones("PREANESTESICA", { ...base, asa: "asa ii e" }).secciones.asa).toBe("IIE");
    const mala = mapearSecciones("PREANESTESICA", { ...base, asa: "VII" });
    expect(mala.secciones.asa).toBeUndefined();
    expect(mala.advertencias.join("\n")).toMatch(/ASA.*«VII»/);
  });

  it("une listas, ignora objetos y cuenta los [verificar]", () => {
    const r = mapearSecciones("INDICACION", { medicamentos: ["Ketorolaco 30 mg IV c/8 h", "Cefalotina 1 g IV c/8 h [verificar]"], dieta: { raro: true }, cuidados: "  " });
    expect(r.secciones).toEqual({ medicamentos: "Ketorolaco 30 mg IV c/8 h; Cefalotina 1 g IV c/8 h [verificar]" });
    expect(r.porVerificar).toBe(1);
    expect(r.advertencias.join("\n")).toMatch(/1 dato marcado \[verificar\]/);
  });

  it("tolera una respuesta sin secciones", () => {
    const r = mapearSecciones("EGRESO", null);
    expect(r.secciones).toEqual({});
    expect(r.faltantes).toEqual([...PLANTILLAS_NOTA.EGRESO.obligatorias]);
  });
});

describe("describirPlantilla", () => {
  it("enseña claves, etiquetas, obligatorias y qué es escala", () => {
    const t = describirPlantilla("POSTANESTESICA");
    expect(t).toMatch(/Nota postanestésica/);
    expect(t).toMatch(/OBLIGATORIAS/);
    expect(t).toMatch(/- aldrete: Escala de Aldrete \(0-10\) \(entero\)/);
    expect(t).toMatch(/Secciones opcionales:\n.*tecnicaAnestesica/);
    expect(describirPlantilla("PREANESTESICA")).toMatch(/- asa: Clasificación ASA \(clase romana\)/);
  });
});
