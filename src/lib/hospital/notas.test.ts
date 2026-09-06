import { describe, expect, it } from "vitest";
import {
  ETIQUETA_SECCION,
  PLANTILLAS_NOTA,
  TIPOS_NOTA,
  canonico,
  contenidoCanonicoNota,
  crearNota,
  errorSecciones,
  hashNota,
  normalizarAsa,
  normalizarAsistencia,
  verificarHashNota,
} from "./notas";

describe("plantillas de nota (NOM-004)", () => {
  it("cubre todos los tipos y cada sección obligatoria tiene etiqueta", () => {
    for (const tipo of TIPOS_NOTA) {
      const p = PLANTILLAS_NOTA[tipo];
      expect(p, tipo).toBeDefined();
      for (const s of [...p.obligatorias, ...p.opcionales]) expect(ETIQUETA_SECCION[s], `${tipo}.${s}`).toBeTruthy();
    }
    expect(PLANTILLAS_NOTA.HISTORIA_CLINICA.obligatorias).toContain("exploracionFisica");
    expect(PLANTILLAS_NOTA.EVOLUCION.obligatorias).toEqual(["subjetivo", "objetivo", "analisis", "plan"]);
    expect(PLANTILLAS_NOTA.PREANESTESICA.obligatorias).toContain("asa");
    expect(PLANTILLAS_NOTA.POSTANESTESICA.obligatorias).toContain("aldrete");
    expect(PLANTILLAS_NOTA.HOJA_URGENCIAS.obligatorias).toContain("triageNivel");
    expect(PLANTILLAS_NOTA.EGRESO.obligatorias).toEqual(["diagnosticoEgreso", "motivoEgreso", "evolucion", "planManejo"]);
  });

  it("las notas que genera el sistema o enfermería no exigen secciones ni cédula", () => {
    expect(errorSecciones("MEDICAMENTO_APLICADO", null)).toBeNull();
    expect(errorSecciones("PROCEDIMIENTO", undefined)).toBeNull();
    expect(PLANTILLAS_NOTA.ENFERMERIA.medica).toBe(false);
    expect(PLANTILLAS_NOTA.MEDICAMENTO_APLICADO.medica).toBe(false);
    expect(PLANTILLAS_NOTA.EVOLUCION.medica).toBe(true);
  });
});

describe("errorSecciones", () => {
  it("exige las secciones obligatorias y dice cuáles faltan", () => {
    expect(errorSecciones("EVOLUCION", null)).toMatch(/requiere las secciones: subjetivo, objetivo, analisis, plan/);
    const e = errorSecciones("EVOLUCION", { subjetivo: "Refiere dolor 2/10", objetivo: "   ", plan: "Alta mañana" });
    expect(e).toMatch(/le faltan: Objetivo/);
    expect(e).toMatch(/Análisis/);
    expect(e).toMatch(/NOM-004/);
  });

  it("acepta una nota completa con secciones extra del hospital", () => {
    expect(
      errorSecciones("EVOLUCION", { subjetivo: "Tolera dieta", objetivo: "TA 118/76, herida limpia", analisis: "Evolución favorable", plan: "Alta mañana", escalaPropia: "x" })
    ).toBeNull();
  });

  it("valida las escalas: Aldrete 0-10, triage 1-5, ASA I-VI", () => {
    const post = { medicamentos: "Propofol", duracion: "2 h", incidentes: "Ninguno", liquidos: "1000 ml", estadoEgresoQuirofano: "Estable", plan: "Recuperación", aldrete: 9 };
    expect(errorSecciones("POSTANESTESICA", post)).toBeNull();
    expect(errorSecciones("POSTANESTESICA", { ...post, aldrete: 11 })).toMatch(/aldrete/);
    expect(errorSecciones("POSTANESTESICA", { ...post, aldrete: "9" })).toMatch(/aldrete/);
    const urg = { triageNivel: 3, motivoAtencion: "Dolor", signosVitales: "TA 130/80", resumenInterrogatorio: "…", exploracionFisica: "…", diagnosticos: "…", tratamiento: "…", pronostico: "Bueno" };
    expect(errorSecciones("HOJA_URGENCIAS", urg)).toBeNull();
    expect(errorSecciones("HOJA_URGENCIAS", { ...urg, triageNivel: 0 })).toMatch(/triageNivel/);
    const pre = { evaluacionClinica: "…", asa: "II", tipoAnestesia: "General", planAnestesico: "…" };
    expect(errorSecciones("PREANESTESICA", pre)).toBeNull();
    expect(errorSecciones("PREANESTESICA", { ...pre, asa: "VII" })).toMatch(/asa/);
  });

  it("rechaza formas inválidas", () => {
    expect(errorSecciones("EVOLUCION", ["a"])).toMatch(/objeto/);
    expect(errorSecciones("EVOLUCION", "texto")).toMatch(/objeto/);
    expect(errorSecciones("PROCEDIMIENTO", { "mal nombre": "x" })).toMatch(/inválido/);
  });
});

describe("normalizarAsa", () => {
  it("normaliza y valida", () => {
    expect(normalizarAsa("ii")).toBe("II");
    expect(normalizarAsa("III E")).toBe("IIIE");
    expect(normalizarAsa("")).toBeNull();
    expect(normalizarAsa(null)).toBeNull();
    expect(() => normalizarAsa("7")).toThrow(/ASA/);
  });
});

describe("firma del sistema", () => {
  const base = {
    episodioId: "ep1",
    tipo: "EVOLUCION" as const,
    fecha: new Date("2026-09-04T13:00:00.000Z"),
    texto: "Tolera dieta líquida.",
    secciones: { plan: "Alta mañana", subjetivo: "Sin dolor", objetivo: "Herida limpia", analisis: "Favorable" },
    autorNombre: "Dr. Alonso Vega",
    autorCedula: "5583201",
    medicoId: "m1",
  };

  it("el contenido canónico ordena las llaves y no depende del orden de captura", () => {
    const a = contenidoCanonicoNota(base);
    const b = contenidoCanonicoNota({ ...base, secciones: { analisis: "Favorable", objetivo: "Herida limpia", subjetivo: "Sin dolor", plan: "Alta mañana" } });
    expect(a).toBe(b);
    expect(a).toContain('"fecha":"2026-09-04T13:00:00.000Z"');
    expect(canonico({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toEqual({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 });
  });

  it("el hash es SHA-256 determinista y cambia con cualquier alteración", () => {
    const h = hashNota(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashNota({ ...base })).toBe(h);
    expect(hashNota({ ...base, texto: "Tolera dieta líquida" })).not.toBe(h);
    expect(hashNota({ ...base, secciones: { ...base.secciones, plan: "Alta hoy" } })).not.toBe(h);
    expect(hashNota({ ...base, autorCedula: "0000000" })).not.toBe(h);
    expect(hashNota({ ...base, fecha: new Date("2026-09-04T13:00:01.000Z") })).not.toBe(h);
  });

  it("verificarHashNota detecta la nota alterada y distingue la no sellada", () => {
    const hash = hashNota(base);
    expect(verificarHashNota({ ...base, hash })).toBe(true);
    expect(verificarHashNota({ ...base, hash, texto: "otro" })).toBe(false);
    expect(verificarHashNota({ ...base, hash: null })).toBeNull();
  });
});

describe("captura asistida (asistencia)", () => {
  it("normalizarAsistencia valida el origen y limpia lo demás", () => {
    expect(normalizarAsistencia(null)).toBeNull();
    expect(normalizarAsistencia(undefined)).toBeNull();
    const a = normalizarAsistencia({ origen: "estructurado", transcripcion: "  dictado  ", modelo: " claude-sonnet-4-5 ", sttProveedor: "OpenAI", at: "2026-09-05T15:00:00Z" });
    expect(a).toEqual({ origen: "ESTRUCTURADO", transcripcion: "dictado", modelo: "claude-sonnet-4-5", sttProveedor: "openai", at: "2026-09-05T15:00:00.000Z" });
    const ahora = new Date("2026-09-05T16:00:00.000Z");
    expect(normalizarAsistencia({ origen: "DICTADO" }, ahora)).toEqual({ origen: "DICTADO", transcripcion: null, modelo: null, sttProveedor: null, at: ahora.toISOString() });
    expect(() => normalizarAsistencia({ origen: "MAGIA" })).toThrow(/asistencia.origen debe ser DICTADO, ESTRUCTURADO, SUGERIDO/);
    expect(() => normalizarAsistencia("DICTADO")).toThrow(/objeto/);
  });

  it("crearNota guarda asistencia sin meterla al hash (la firma cubre lo clínico)", async () => {
    const creados: Array<Record<string, unknown>> = [];
    const db = {
      hospMedico: { findUnique: async () => ({ companyId: "c1", nombre: "Dr. Alonso Vega", cedula: "5583201" }) },
      hospNota: {
        findUnique: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          creados.push(data);
          return { id: "n1", ...data, medico: null };
        },
      },
    };
    const ahora = new Date("2026-09-05T15:00:00.000Z");
    const asistencia = normalizarAsistencia({ origen: "ESTRUCTURADO", transcripcion: "tolera dieta líquida sin dolor plan alta mañana", modelo: "claude-sonnet-4-5", at: ahora.toISOString() })!;
    const secciones = { subjetivo: "Sin dolor", objetivo: "Herida limpia", analisis: "Favorable", plan: "Alta mañana" };
    const nota = await crearNota(db as never, {
      companyId: "c1", episodioId: "ep1", tipo: "EVOLUCION", texto: "Tolera dieta líquida.", secciones, medicoId: "m1", usuario: { id: "u1", nombre: "Dr. Alonso Vega" }, ahora, asistencia,
    });
    expect(creados[0].asistencia).toEqual(asistencia);
    const esperado = hashNota({ episodioId: "ep1", tipo: "EVOLUCION", fecha: ahora, texto: "Tolera dieta líquida.", secciones: canonico(secciones), autorNombre: "Dr. Alonso Vega", autorCedula: "5583201", medicoId: "m1", reemplazaId: null });
    expect(nota.hash).toBe(esperado);
    // Sin asistencia el hash es el mismo: la trazabilidad no altera la firma.
    const sin = await crearNota(db as never, {
      companyId: "c1", episodioId: "ep1", tipo: "EVOLUCION", texto: "Tolera dieta líquida.", secciones, medicoId: "m1", usuario: { id: "u1", nombre: "Dr. Alonso Vega" }, ahora,
    });
    expect(sin.hash).toBe(esperado);
    expect(creados[1].asistencia).toBeUndefined();
  });
});
