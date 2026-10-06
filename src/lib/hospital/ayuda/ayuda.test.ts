import { beforeEach, describe, expect, it, vi } from "vitest";

const { llamar } = vi.hoisted(() => ({ llamar: vi.fn() }));
vi.mock("../asistente/modelo", () => ({ llamarModelo: llamar }));

import { HospitalError } from "../errores";
import { armarSistema, armarTurno, normalizarPregunta, preguntarAyuda, puedeVerAyuda, sanearRespuesta, type PerfilAyuda } from "./ayuda";
import { PAGINAS_AYUDA } from "./conocimiento";
import { resumirPreguntas } from "./tablero";

const enfermeria: PerfilAyuda = { rol: "ACCOUNTANT", paginas: ["censo", "agenda", "pacientes", "episodios", "farmacia"], permisos: ["CLINICA_LEER"], puesto: "Enfermería" };
const direccion: PerfilAyuda = { rol: "OWNER", paginas: [], permisos: [], puesto: null };

describe("visibilidad de páginas para la ayuda", () => {
  it("sigue la rejilla, con las páginas que también abren otra", () => {
    expect(puedeVerAyuda(enfermeria, "censo")).toBe(true);
    expect(puedeVerAyuda(enfermeria, "nomina")).toBe(false);
    expect(puedeVerAyuda({ rol: "ACCOUNTANT", paginas: ["caja"] }, "facturacion")).toBe(true);
    expect(puedeVerAyuda(direccion, "nomina")).toBe(true);
  });
  it("Usuarios sólo dueño/admin; Configuración siempre", () => {
    expect(puedeVerAyuda(direccion, "usuarios")).toBe(true);
    expect(puedeVerAyuda({ rol: "ACCOUNTANT", paginas: [] }, "usuarios")).toBe(false);
    expect(puedeVerAyuda(enfermeria, "configuracion")).toBe(true);
  });
});

describe("prompt", () => {
  it("el sistema lleva el nombre de la mascota y la guía", () => {
    const s = armarSistema("Lupa");
    expect(s).toContain("Eres Lupa");
    expect(s).toContain("GUÍA DE HOSPITALOS");
  });
  it("el turno dice qué ve y qué no ve el usuario, dónde está y la conversación", () => {
    const t = armarTurno({
      pregunta: "¿Dónde veo la nómina?",
      pagina: "censo",
      historial: [{ rol: "usuario", texto: "hola" }, { rol: "mascota", texto: "¡Hola!" }],
      perfil: enfermeria,
    });
    expect(t).toContain("Puesto: Enfermería");
    expect(t).toMatch(/Páginas que NO ve: .*nomina/);
    expect(t).toContain("Página donde está: censo (Censo y camas)");
    expect(t).toContain("Usuario: hola\nTú: ¡Hola!");
    expect(t.endsWith("¿Dónde veo la nómina?")).toBe(true);
  });
  it("sin restricción dice que ve todas", () => {
    expect(armarTurno({ pregunta: "x", pagina: null, historial: [], perfil: direccion })).toContain("Páginas que ve: todas");
  });
});

describe("sanearRespuesta", () => {
  it("descarta páginas inventadas o que el usuario no ve, y acota a 3", () => {
    const r = sanearRespuesta({ respuesta: " Ve a Censo. ", paginas: ["censo", "nomina", "inventada", "censo", "agenda", "pacientes", "episodios"], sinRespuesta: false }, enfermeria);
    expect(r).toEqual({ respuesta: "Ve a Censo.", paginas: ["censo", "agenda", "pacientes"], sinRespuesta: false });
  });
  it("sin texto no hay respuesta", () => {
    expect(sanearRespuesta({ respuesta: "  ", paginas: [] }, enfermeria)).toBeNull();
    expect(sanearRespuesta({ paginas: ["censo"] }, enfermeria)).toBeNull();
  });
});

describe("preguntarAyuda", () => {
  const create = vi.fn();
  const db = { hospAyudaPregunta: { create } } as never;
  const args = { companyId: "c", userId: "u", userNombre: "Ana", nombreMascota: "Mochi", pregunta: "¿Cómo cobro?", pagina: "caja", historial: [], perfil: direccion };
  beforeEach(() => { llamar.mockReset(); create.mockReset(); create.mockResolvedValue({ id: "p1" }); });

  it("guarda la pregunta con la respuesta saneada", async () => {
    llamar.mockResolvedValue({ datos: { respuesta: "En Caja.", paginas: ["caja"], sinRespuesta: false }, modelo: "claude-haiku-4-5" });
    const r = await preguntarAyuda(db, args);
    expect(r).toEqual({ id: "p1", modelo: "claude-haiku-4-5", respuesta: "En Caja.", paginas: ["caja"], sinRespuesta: false });
    expect(llamar.mock.calls[0][0]).toMatchObject({ subtipo: "hospital.ayuda", companyId: "c", userId: "u" });
    expect(create.mock.calls[0][0].data).toMatchObject({ pregunta: "¿Cómo cobro?", pagina: "caja", paginasSugeridas: ["caja"], userNombre: "Ana" });
  });
  it("el tope de IA (429) sale tal cual; otras fallas con mensaje de ayuda", async () => {
    llamar.mockRejectedValueOnce(new HospitalError(429, "tope"));
    await expect(preguntarAyuda(db, args)).rejects.toMatchObject({ status: 429, message: "tope" });
    llamar.mockRejectedValueOnce(new HospitalError(502, "captura la nota a mano"));
    await expect(preguntarAyuda(db, args)).rejects.toMatchObject({ status: 502, message: expect.stringContaining("ayuda") });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("tablero", () => {
  it("cuenta valoraciones, agrupa por página y junta repetidas", () => {
    const d = (n: number) => new Date(2026, 9, n);
    const r = resumirPreguntas([
      { createdAt: d(1), pagina: "caja", pregunta: "¿Cómo facturo?", sinRespuesta: false, util: true },
      { createdAt: d(3), pagina: "caja", pregunta: "como FACTURO", sinRespuesta: false, util: false },
      { createdAt: d(2), pagina: null, pregunta: "¿Puedo exportar a Excel?", sinRespuesta: true, util: null },
    ]);
    expect(r.resumen).toEqual({ total: 3, utiles: 1, noUtiles: 1, sinValorar: 1, sinRespuesta: 1 });
    expect(r.porPagina[0]).toEqual({ pagina: "caja", total: 2, noUtiles: 1, sinRespuesta: 0 });
    expect(r.repetidas).toEqual([{ pregunta: "¿Cómo facturo?", veces: 2, ultima: d(3) }]);
  });
  it("normaliza acentos y signos", () => {
    expect(normalizarPregunta("¿Cómo  FACTURO?")).toBe("como facturo");
  });
});

it("el catálogo de páginas no repite llaves", () => {
  expect(new Set(PAGINAS_AYUDA.map((p) => p.key)).size).toBe(PAGINAS_AYUDA.length);
});
