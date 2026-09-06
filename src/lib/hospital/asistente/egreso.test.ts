import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { errorSecciones } from "../notas";
import { EPISODIO_BASE, dbFalsa, type NotaFalsa } from "./__fixtures__/db";

vi.mock("./modelo", () => ({ llamarModelo: vi.fn() }));

import { llamarModelo } from "./modelo";
import { proponerEgreso } from "./egreso";
import { codificarEpisodio } from "./codificar";
import { renderNotas } from "./contexto";

const HOY = new Date("2026-09-05T15:00:00.000Z");
const modelo = vi.mocked(llamarModelo);

// Insertadas FUERA de orden a propósito: el egreso se arma cronológico.
const NOTAS: NotaFalsa[] = [
  {
    id: "n-evo", tipo: "EVOLUCION", fecha: new Date("2026-09-05T13:30:00.000Z"), texto: "Tolera dieta, deambula. Plan: alta mañana.",
    secciones: { subjetivo: "Dolor 2/10", objetivo: "Puertos limpios", analisis: "POP día 1 favorable", plan: "Dieta blanda, analgesia oral; alta mañana" },
  },
  {
    id: "n-post", tipo: "POSTOPERATORIA", fecha: new Date("2026-09-04T17:40:00.000Z"), texto: "Colecistectomía laparoscópica sin complicaciones.",
    secciones: { diagnosticoPostoperatorio: "K80.2 Litiasis vesicular", operacionRealizada: "Colecistectomía laparoscópica (51.23)", tecnica: "Cuatro puertos", hallazgos: "Litos múltiples", sangrado: "30 ml", conteoGasas: "Completo", incidentes: "Ninguno", estadoPostquirurgico: "Estable", plan: "Recuperación" },
  },
  { id: "n-med", tipo: "MEDICAMENTO_APLICADO", fecha: new Date("2026-09-04T14:35:00.000Z"), texto: "Midazolam 5 mg · lote M-1 · 1 pz", secciones: { medicamento: "Midazolam", dosis: "2 mg", via: "IV" } },
  {
    id: "n-hc", tipo: "HISTORIA_CLINICA", fecha: new Date("2026-09-04T13:40:00.000Z"), texto: "Historia clínica de ingreso.",
    secciones: { antecedentesPersonalesPatologicos: "Hipertensión arterial en tratamiento con losartán", padecimientoActual: "Cólico biliar de repetición", diagnosticos: "K80.2 Cálculo de la vesícula biliar sin colecistitis" },
  },
  { id: "n-vieja", tipo: "EVOLUCION", fecha: new Date("2026-09-05T08:00:00.000Z"), texto: "Versión superada.", secciones: null, reemplazadaPor: { id: "n-evo" } },
  {
    id: "n-pa", tipo: "POSTANESTESICA", fecha: new Date("2026-09-04T17:30:00.000Z"), texto: "Aldrete 9.",
    secciones: { tecnicaAnestesica: "General balanceada", medicamentos: "Propofol", duracion: "2 h 30", incidentes: "Ninguno", liquidos: "Hartmann 1500", estadoEgresoQuirofano: "Despierta", aldrete: 9, plan: "Recuperación" },
  },
  { id: "n-pre", tipo: "PREANESTESICA", fecha: new Date("2026-09-04T13:55:00.000Z"), texto: "ASA I.", secciones: { evaluacionClinica: "Mallampati I", asa: "I", tipoAnestesia: "General balanceada", planAnestesico: "Propofol" } },
];

const RESPUESTA_EGRESO = {
  secciones: {
    diagnosticoEgreso: "Litiasis vesicular sin colecistitis (K80.2), postoperada de colecistectomía laparoscópica. Hipertensión arterial [verificar].",
    motivoEgreso: "Mejoría",
    evolucion: "Ingresa el 4 de septiembre para colecistectomía laparoscópica programada por cólico biliar de repetición; se opera el mismo día sin incidentes (sangrado 30 ml). Evoluciona favorablemente: tolera dieta y deambula al día 1.",
    planManejo: "Dieta blanda, analgesia oral; alta al día siguiente si continúa la evolución.",
    problemasPendientes: "",
    pronostico: "",
    recomendaciones: "",
    causaDefuncion: "",
    diasEstancia: "99",
    invento: "no va",
  },
  motivoEgresoClave: "mejoria",
  texto: "Egreso por mejoría tras colecistectomía laparoscópica sin complicaciones.",
  codigos: {
    diagnosticos: [
      { codigo: "I10", nombre: "Hipertensión esencial", confianza: 0.8, fragmento: "Hipertensión arterial en tratamiento con losartán" },
      { codigo: "K80.2", nombre: "Cálculo de la vesícula biliar sin colecistitis", principal: true, confianza: 0.97, fragmento: "K80.2 Litiasis vesicular" },
    ],
    procedimientos: [{ codigo: "51.23", nombre: "Colecistectomía laparoscópica", confianza: 0.98, fragmento: "Colecistectomía laparoscópica (51.23)" }],
  },
  causaExterna: { codigo: "S72.0", nombre: "no aplica", confianza: 0.4, fragmento: "…" },
  advertencias: ["Las notas no traen medicamentos de egreso con dosis: pendiente de que el médico los dicte."],
};

beforeEach(() => {
  modelo.mockReset();
});

describe("proponerEgreso", () => {
  it("arma el borrador con las notas en orden cronológico y reparte las sugerencias SAEH", async () => {
    modelo.mockResolvedValue({ datos: RESPUESTA_EGRESO, modelo: "claude-sonnet-4-5", intentos: 1, usage: { inputTokens: 3000, outputTokens: 800 } });
    const db = dbFalsa([{ ...EPISODIO_BASE, notas: NOTAS }]) as unknown as PrismaClient;
    const r = await proponerEgreso(db, { companyId: "c1", episodioId: "ep1", userId: "u1", hoy: HOY });

    // El modelo vio las notas vigentes, cronológicas, sin la reemplazada ni las de medicamento aplicado.
    const prompt = modelo.mock.calls[0][0].user;
    const encabezados = [...prompt.matchAll(/^### (.+?) — (\S+ \S+)$/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(encabezados).toEqual([
      "Historia clínica 2026-09-04 07:40",
      "Nota preanestésica 2026-09-04 07:55",
      "Nota postanestésica 2026-09-04 11:30",
      "Nota postoperatoria 2026-09-04 11:40",
      "Nota de evolución 2026-09-05 07:30",
    ]);
    expect(prompt).not.toMatch(/Versión superada|Midazolam 5 mg/);
    expect(prompt).toMatch(/- Antecedentes personales patológicos: Hipertensión arterial/);
    expect(modelo.mock.calls[0][0].subtipo).toBe("hospital.asistente.egreso");

    // Secciones de la plantilla EGRESO; lo que no es opinión lo pone el hub.
    expect(r.tipo).toBe("EGRESO");
    expect(r.secciones.diasEstancia).toBe(1);
    expect(r.diasEstancia).toBe(1);
    expect(r.secciones).not.toHaveProperty("invento");
    expect(r.secciones.motivoEgreso).toBe("Mejoría");
    expect(r.faltantes).toEqual([]);
    expect(errorSecciones("EGRESO", r.secciones)).toBeNull();
    expect(r.motivoEgresoClave).toBe("MEJORIA");
    expect(r.aldrete).toBe(9);
    expect(r.texto).toBe(RESPUESTA_EGRESO.texto);

    // Códigos validados: principal primero.
    expect(r.codigos.diagnosticos.map((d) => d.codigo)).toEqual(["K80.2", "I10.X"]);
    expect(r.codigos.procedimientos.map((p) => p.codigo)).toEqual(["51.23"]);

    // SAEH: afección principal, comorbilidades, procedimiento con anestesia general (1), quirófano dentro y cédula del cirujano.
    expect(r.saeh.afeccionPrincipal).toEqual(expect.objectContaining({ codigo: "K80.2", clave: "K802", descripcion: "CÁLCULO DE LA VESÍCULA BILIAR SIN COLECISTITIS" }));
    expect(r.saeh.comorbilidades).toEqual([expect.objectContaining({ codigo: "I10.X", clave: "I10X" })]);
    expect(r.saeh.procedimientos).toEqual([expect.objectContaining({ codigo: "51.23", clave: "5123", tipoAnestesia: 1, quirofano: 1, cedula: "5583201" })]);
    expect(r.saeh.causaExterna).toBeNull();

    const adv = r.advertencias.join("\n");
    expect(adv).toMatch(/«S72\.0 .*» como causa externa: no es del capítulo XX/);
    expect(adv).toMatch(/pendiente de que el médico los dicte/);
    expect(adv).toMatch(/aún no tiene alta/);
    expect(adv).toMatch(/1 dato marcado \[verificar\]/);
    expect(r.notas).toEqual({ incluidas: 5, omitidas: 0 });
    expect(r.asistencia).toEqual({ origen: "SUGERIDO", modelo: "claude-sonnet-4-5", at: HOY.toISOString() });
  });

  it("sin notas no llama al modelo (409)", async () => {
    const db = dbFalsa([{ ...EPISODIO_BASE, notas: [] }]) as unknown as PrismaClient;
    await expect(proponerEgreso(db, { companyId: "c1", episodioId: "ep1", userId: "u1" })).rejects.toMatchObject({ status: 409 });
    expect(modelo).not.toHaveBeenCalled();
  });

  it("con alta registrada cuenta los días hasta el alta y respeta un motivo inválido como null", async () => {
    modelo.mockResolvedValue({ datos: { ...RESPUESTA_EGRESO, motivoEgresoClave: "SE FUE" }, modelo: "m", intentos: 1, usage: { inputTokens: 1, outputTokens: 1 } });
    const db = dbFalsa([{ ...EPISODIO_BASE, estado: "ALTA", fechaAlta: new Date("2026-09-06T16:00:00.000Z"), notas: NOTAS }]) as unknown as PrismaClient;
    const r = await proponerEgreso(db, { companyId: "c1", episodioId: "ep1", userId: "u1", hoy: HOY });
    expect(r.diasEstancia).toBe(2);
    expect(r.motivoEgresoClave).toBeNull();
    expect(r.advertencias.join("\n")).not.toMatch(/aún no tiene alta/);
  });
});

describe("codificarEpisodio", () => {
  it("codifica las notas del episodio y valida los tres bloques", async () => {
    modelo.mockResolvedValue({
      datos: { diagnosticos: [{ codigo: "K80.2", principal: true, confianza: 0.9, fragmento: "K80.2" }, { codigo: "K80", confianza: 0.5, fragmento: "litiasis" }], procedimientos: [{ codigo: "51.23", confianza: 0.9, fragmento: "51.23" }], causaExterna: { codigo: "V43.5", confianza: 0.6, fragmento: "choque" }, advertencias: ["x"] },
      modelo: "m", intentos: 1, usage: { inputTokens: 1, outputTokens: 1 },
    });
    const db = dbFalsa([{ ...EPISODIO_BASE, notas: NOTAS }]) as unknown as PrismaClient;
    const r = await codificarEpisodio(db, { companyId: "c1", episodioId: "ep1", userId: "u1", hoy: HOY });
    expect(r.diagnosticos.map((d) => d.codigo)).toEqual(["K80.2"]);
    expect(r.procedimientos.map((d) => d.codigo)).toEqual(["51.23"]);
    expect(r.causaExterna?.codigo).toBe("V43.5");
    expect(r.fuente).toEqual({ origen: "NOTAS", notasIncluidas: 5, notasOmitidas: 0 });
    expect(r.advertencias).toEqual(["x", expect.stringMatching(/«K80».*no es válido/)]);
    expect(modelo.mock.calls[0][0].user).toMatch(/Códigos ya capturados en el episodio .*ingreso K80.2, procedimiento 51.23/);
    expect(modelo.mock.calls[0][0].user).toMatch(/<<<NOTAS>>>/);
  });

  it("con texto codifica ese texto y no carga notas", async () => {
    modelo.mockResolvedValue({ datos: { diagnosticos: [], procedimientos: [], causaExterna: null }, modelo: "m", intentos: 1, usage: { inputTokens: 1, outputTokens: 1 } });
    const db = dbFalsa([{ ...EPISODIO_BASE, notas: [] }]) as unknown as PrismaClient;
    const r = await codificarEpisodio(db, { companyId: "c1", episodioId: "ep1", texto: "Fractura de cuello de fémur por caída", userId: "u1" });
    expect(r.fuente.origen).toBe("TEXTO");
    expect(modelo.mock.calls[0][0].user).toMatch(/<<<TEXTO>>>\nFractura de cuello de fémur/);
  });

  it("sin notas ni texto es 409", async () => {
    const db = dbFalsa([{ ...EPISODIO_BASE, notas: [] }]) as unknown as PrismaClient;
    await expect(codificarEpisodio(db, { companyId: "c1", episodioId: "ep1", userId: "u1" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("renderNotas", () => {
  it("recorta las notas más antiguas cuando el corpus no cabe", () => {
    const grande = (id: string, fecha: string) => ({ id, tipo: "EVOLUCION" as const, fecha: new Date(fecha), texto: "x".repeat(2000), secciones: { subjetivo: "y".repeat(2500), objetivo: "z".repeat(2500), analisis: "a".repeat(2500), plan: "b".repeat(2500) } });
    const notas = Array.from({ length: 8 }, (_, i) => grande(`n${i}`, `2026-09-0${i + 1}T12:00:00.000Z`));
    const r = renderNotas(notas);
    expect(r.incluidas + r.omitidas).toBe(8);
    expect(r.omitidas).toBeGreaterThan(0);
    expect(r.texto.length).toBeLessThanOrEqual(60_000);
    expect(r.texto).toMatch(/2026-09-08/);
    expect(r.texto).not.toMatch(/2026-09-01/);
  });
});
