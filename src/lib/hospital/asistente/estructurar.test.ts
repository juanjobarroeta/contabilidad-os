import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { errorSecciones } from "../notas";
import { DICTADO_POSTOPERATORIA, RESPUESTA_MODELO_POSTOPERATORIA, SECCIONES_ESPERADAS_POSTOPERATORIA } from "./__fixtures__/postoperatoria-dictado";
import { EPISODIO_BASE, dbFalsa } from "./__fixtures__/db";

vi.mock("./modelo", () => ({ llamarModelo: vi.fn() }));

import { llamarModelo } from "./modelo";
import { armarPromptEstructurar, estructurarNota } from "./estructurar";
import { leerPropuestas, validarCodigos } from "./codigos";
import { cargarEpisodioAsistente } from "./contexto";

const HOY = new Date("2026-09-05T15:00:00.000Z");
const modelo = vi.mocked(llamarModelo);

beforeEach(() => {
  modelo.mockReset();
});

const db = () => dbFalsa() as unknown as PrismaClient;

describe("estructurarNota (dictado postoperatorio)", () => {
  it("mapea el dictado a la plantilla, reporta faltantes y valida los códigos con el catálogo y el paciente", async () => {
    modelo.mockResolvedValue({ datos: RESPUESTA_MODELO_POSTOPERATORIA, modelo: "claude-sonnet-4-5", intentos: 1, usage: { inputTokens: 900, outputTokens: 400 } });
    const paciente = { sexo: "MASCULINO" as const, fechaNacimiento: new Date("1981-05-02T18:00:00.000Z") };
    const r = await estructurarNota(dbFalsa([{ ...EPISODIO_BASE, paciente }]) as unknown as PrismaClient, {
      companyId: "c1",
      episodioId: "ep1",
      tipo: "POSTOPERATORIA",
      texto: DICTADO_POSTOPERATORIA,
      userId: "u1",
      hoy: HOY,
    });

    // Secciones: sólo las de la plantilla, sin la vacía (conteoGasas) ni la inventada (evolucionEsperada).
    expect(r.secciones).toEqual(SECCIONES_ESPERADAS_POSTOPERATORIA);
    expect(r.faltantes).toEqual(["conteoGasas"]);
    expect(r.texto).toBe(RESPUESTA_MODELO_POSTOPERATORIA.texto);
    // Lo que falta impide guardar tal cual: el médico completa y firma.
    expect(errorSecciones("POSTOPERATORIA", r.secciones)).toMatch(/Reporte de gasas/);
    expect(errorSecciones("POSTOPERATORIA", { ...r.secciones, conteoGasas: "Completo 10/10" })).toBeNull();

    // Códigos: K80.2 y 51.23 pasan; K80 y 51.2 no son codificables; O80.0 es de mujer; Z99.9 no existe; k80.2 repetido se funde.
    expect(r.codigos.diagnosticos).toEqual([
      expect.objectContaining({ codigo: "K80.2", clave: "K802", nombre: "CÁLCULO DE LA VESÍCULA BILIAR SIN COLECISTITIS", confianza: 0.97, fragmento: "litiasis vesicular sin colecistitis K80.2" }),
    ]);
    expect(r.codigos.procedimientos).toEqual([expect.objectContaining({ codigo: "51.23", clave: "5123", nombre: "COLECISTECTOMÍA LAPAROSCÓPICA" })]);
    const adv = r.advertencias.join("\n");
    expect(adv).toMatch(/«K80».*no es válido para codificar.*subcategoría/);
    expect(adv).toMatch(/«O80\.0».*exclusivo de sexo femenino y el paciente es masculino/);
    expect(adv).toMatch(/«Z99\.9».*no existe en el catálogo CIE-10/);
    expect(adv).toMatch(/«51\.2».*no es válido para codificar/);
    // Las del modelo y las del mapeo también llegan, sin duplicados.
    expect(adv).toMatch(/No se dictó el conteo de gasas/);
    expect(adv).toMatch(/Faltan secciones obligatorias .*Reporte de gasas y compresas/);
    expect(adv).toMatch(/se descartaron: evolucionEsperada/);
    expect(adv).toMatch(/1 dato marcado \[verificar\]/);
    expect(new Set(r.advertencias).size).toBe(r.advertencias.length);

    expect(r.asistencia).toEqual({ origen: "ESTRUCTURADO", modelo: "claude-sonnet-4-5", at: HOY.toISOString() });
    expect(r.uso).toEqual({ intentos: 1, inputTokens: 900, outputTokens: 400 });

    // Lo que vio el modelo: plantilla, contexto sin datos personales, signos y el dictado delimitado.
    const llamada = modelo.mock.calls[0][0];
    expect(llamada.subtipo).toBe("hospital.asistente.estructurar");
    expect(llamada.companyId).toBe("c1");
    expect(llamada.userId).toBe("u1");
    expect(llamada.user).toMatch(/Plantilla: Nota postoperatoria/);
    expect(llamada.user).toMatch(/sexo masculino, edad 45 años/);
    expect(llamada.user).toMatch(/Últimos signos vitales .*TA 118\/76, FC 72/);
    expect(llamada.user).toMatch(/<<<DICTADO>>>\nnota postoperatoria paciente/);
    expect(llamada.user).not.toMatch(/Ortega|CURP/);
  });

  it("sin resumen del modelo usa el dictado como texto y sin signos no los manda", async () => {
    modelo.mockResolvedValue({ datos: { secciones: { plan: "Alta" } }, modelo: "m", intentos: 2, usage: { inputTokens: 1, outputTokens: 1 } });
    const r = await estructurarNota(db(), { companyId: "c1", episodioId: "ep1", tipo: "INDICACION", texto: "  plan alta  ", userId: "u1", contexto: { signos: false }, hoy: HOY });
    expect(r.texto).toBe("plan alta");
    expect(r.secciones).toEqual({});
    expect(r.faltantes).toEqual([]);
    expect(r.codigos).toEqual({ diagnosticos: [], procedimientos: [] });
    expect(modelo.mock.calls[0][0].user).not.toMatch(/signos vitales/);
  });

  it("no llama al modelo con texto vacío, episodio ajeno o cancelado", async () => {
    await expect(estructurarNota(db(), { companyId: "c1", episodioId: "ep1", tipo: "EVOLUCION", texto: "   ", userId: "u1" })).rejects.toMatchObject({ status: 400 });
    await expect(estructurarNota(db(), { companyId: "otra", episodioId: "ep1", tipo: "EVOLUCION", texto: "x", userId: "u1" })).rejects.toMatchObject({ status: 404 });
    const cancelado = dbFalsa([{ ...EPISODIO_BASE, estado: "CANCELADO" }]) as unknown as PrismaClient;
    await expect(estructurarNota(cancelado, { companyId: "c1", episodioId: "ep1", tipo: "EVOLUCION", texto: "x", userId: "u1" })).rejects.toMatchObject({ status: 409 });
    expect(modelo).not.toHaveBeenCalled();
  });
});

describe("validarCodigos", () => {
  it("ordena principal primero y luego por confianza; la causa externa exige capítulo XX", async () => {
    const propuestas = leerPropuestas([
      { codigo: "I10", nombre: "HTA", confianza: 0.8, fragmento: "hipertenso" },
      { codigo: "K80.2", nombre: "Litiasis", confianza: 0.7, fragmento: "litiasis", principal: true },
      { codigo: "K80.0", nombre: "Litiasis aguda", confianza: "0.9", fragmento: null },
      { codigo: "", nombre: "vacío" },
      "basura",
    ]);
    expect(propuestas.map((p) => p.codigo)).toEqual(["I10", "K80.2", "K80.0"]);
    expect(propuestas[2].confianza).toBe(0.9);
    const r = await validarCodigos(db(), propuestas, { tipo: "CIE10", etiqueta: "El diagnóstico propuesto" });
    expect(r.validos.map((v) => [v.codigo, v.clave])).toEqual([["K80.2", "K802"], ["K80.0", "K800"], ["I10.X", "I10X"]]);
    expect(r.advertencias).toEqual([]);

    const ce = await validarCodigos(db(), leerPropuestas([{ codigo: "S72.0", confianza: 0.9 }, { codigo: "V43.5", confianza: 0.8 }]), { tipo: "CIE10", etiqueta: "La causa externa propuesta", soloCapituloXX: true });
    expect(ce.validos.map((v) => v.codigo)).toEqual(["V43.5"]);
    expect(ce.advertencias[0]).toMatch(/«S72\.0 .*» como causa externa: no es del capítulo XX/);
  });

  it("cruza la edad del paciente", async () => {
    const bebe = { sexo: "MASCULINO" as const, fechaNacimiento: new Date("2026-08-30T18:00:00.000Z") };
    const r = await validarCodigos(db(), leerPropuestas([{ codigo: "K80.2", confianza: 0.9 }]), { tipo: "CIE10", etiqueta: "El diagnóstico propuesto", paciente: bebe, hoy: HOY });
    expect(r.validos).toEqual([]);
    expect(r.advertencias[0]).toMatch(/no aplica a la edad del paciente/);
  });
});

describe("contexto", () => {
  it("carga el episodio con sus signos y notas vigentes en orden", async () => {
    const ep = await cargarEpisodioAsistente(db(), { companyId: "c1", episodioId: "ep1", signos: 1 });
    expect(ep.folio).toBe("HOSP-2026-0418");
    expect(ep.signos).toHaveLength(1);
    expect(ep.signos[0].temperatura).toBe(36.4);
    expect(ep.notas).toEqual([]);
    const prompt = armarPromptEstructurar(ep, "EVOLUCION", "dictado", { hoy: HOY });
    expect(prompt).toMatch(/Tipo de episodio: hospitalización · estado actual: postoperatorio/);
    expect(prompt).toMatch(/Paciente: sexo femenino, edad 34 años/);
    expect(prompt).toMatch(/Diagnóstico de trabajo del episodio: K80.2 Cálculo de vesícula biliar/);
    expect(prompt).toMatch(/Procedimiento del episodio: 51.23 Colecistectomía laparoscópica/);
  });
});
