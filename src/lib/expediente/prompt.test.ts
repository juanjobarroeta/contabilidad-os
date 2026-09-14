import { describe, it, expect } from "vitest";
import { antiguedad, bloqueExpedienteParaPrompt, valorEnTexto, type Expediente } from "./prompt";
import type { HechoExpediente } from "./hechos";
import type { NotaExpediente } from "./notas";

const HOY = new Date("2026-09-14T12:00:00Z");

const hecho = (extra: Partial<HechoExpediente> = {}): HechoExpediente => ({
  id: "h1",
  clave: "terminal.afiliacion",
  titulo: "Afiliación de terminal",
  familia: "terminal",
  valor: "Banorte 7788",
  fuente: "motor",
  evidencia: [],
  vigenteDesde: new Date("2026-03-01T00:00:00Z"),
  vigenteHasta: null,
  confianza: "media",
  verificado: false,
  ...extra,
});

const nota = (extra: Partial<NotaExpediente> = {}): NotaExpediente => ({
  id: "n1",
  createdAt: new Date("2026-09-01T00:00:00Z"),
  autor: "agente",
  autorId: null,
  tipo: "pendiente",
  tema: "conciliacion",
  titulo: "Falta el estado de cuenta de la terminal",
  cuerpo: "Sin él no se pueden auditar las liquidaciones del centro de procedimientos.",
  refs: [],
  datos: null,
  estado: "abierta",
  resueltaAt: null,
  resueltaPorNotaId: null,
  ...extra,
});

const vacio: Expediente = { hechos: [], pendientes: [], notas: [] };

describe("bloqueExpedienteParaPrompt", () => {
  it("una empresa sin expediente igual recibe la instrucción de empezar a escribirlo", () => {
    // Si el bloque desapareciera por estar vacío, el expediente no arrancaría
    // nunca: el modelo no sabría que puede escribirlo.
    const b = bloqueExpedienteParaPrompt(vacio, HOY);
    expect(b).toContain("registrar_hecho");
    expect(b).toContain("anotar_expediente");
  });

  it("los compromisos abiertos van ARRIBA de todo lo demás", () => {
    const b = bloqueExpedienteParaPrompt({ hechos: [hecho()], pendientes: [nota()], notas: [] }, HOY);
    expect(b.indexOf("Compromisos abiertos")).toBeLessThan(b.indexOf("Lo que sabemos"));
  });

  it("un hecho sin verificar se presenta como tal", () => {
    const b = bloqueExpedienteParaPrompt({ ...vacio, hechos: [hecho()] }, HOY);
    expect(b).toContain("sin verificar");
  });

  it("un hecho verificado NO se marca: sólo se advierte de lo que no está confirmado", () => {
    // Se mira SU renglón, no el bloque entero: las reglas de uso mencionan
    // «sin verificar» siempre, para explicar qué significa la marca.
    const linea = (verificado: boolean) =>
      bloqueExpedienteParaPrompt({ ...vacio, hechos: [hecho({ verificado })] }, HOY)
        .split("\n")
        .find((l) => l.includes("Banorte 7788"))!;
    expect(linea(true)).not.toContain("sin verificar");
    expect(linea(false)).toContain("sin verificar");
  });

  it("agrupa los hechos por familia en vez de listarlos sueltos", () => {
    const b = bloqueExpedienteParaPrompt(
      {
        ...vacio,
        hechos: [hecho(), hecho({ id: "h2", clave: "terminal.adquirente", familia: "terminal", valor: "Banorte" })],
      },
      HOY,
    );
    expect((b.match(/^- terminal:/gm) ?? [])).toHaveLength(1);
  });

  it("dice desde cuándo rige un hecho: es la pregunta que aparece cuando algo no cuadra", () => {
    const b = bloqueExpedienteParaPrompt({ ...vacio, hechos: [hecho()] }, HOY);
    expect(b).toMatch(/desde \d{2} \w+/);
  });

  it("le dice al modelo que no vuelva a reportar lo que ya tiene compromiso abierto", () => {
    const b = bloqueExpedienteParaPrompt({ ...vacio, pendientes: [nota()] }, HOY);
    expect(b).toContain("No vuelvas a reportar");
  });

  it("nunca se queda sin las reglas de uso, aunque sólo haya una nota", () => {
    const b = bloqueExpedienteParaPrompt({ ...vacio, notas: [nota({ tipo: "observacion", estado: "resuelta" })] }, HOY);
    expect(b).toContain("Cómo usar el expediente");
  });
});

describe("valorEnTexto", () => {
  it("aplana un objeto sin enseñar JSON crudo al modelo", () => {
    expect(valorEnTexto({ banco: "Banorte", afiliacion: "7788" })).toBe("banco: Banorte; afiliacion: 7788");
  });
  it("un valor ausente se lee como raya, no como «null»", () => {
    expect(valorEnTexto(null)).toBe("—");
  });
});

describe("antiguedad", () => {
  it("habla en días, no en marcas de tiempo", () => {
    expect(antiguedad(HOY, HOY)).toBe("hoy");
    expect(antiguedad(new Date("2026-09-13T12:00:00Z"), HOY)).toBe("ayer");
    expect(antiguedad(new Date("2026-09-01T12:00:00Z"), HOY)).toBe("hace 13 días");
    expect(antiguedad(new Date("2026-08-01T12:00:00Z"), HOY)).toBe("hace un mes");
  });
});
