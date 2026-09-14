import { describe, it, expect } from "vitest";
import { mensajeDePasada, normalizarResumen, promptDelContador, resumenEnTexto } from "./prompt";
import { cadenciaDePlan, tocaHoy } from "./claves";
import type { DimensionSalud } from "@/lib/salud/evaluar";

const HOY = new Date("2026-09-14T12:00:00Z"); // lunes

const dim = (extra: Partial<DimensionSalud> = {}): DimensionSalud => ({
  clave: "bancos",
  titulo: "Bancos",
  estado: "atencion",
  detalle: "40 movimientos llevan más de dos meses sin conciliar.",
  metricas: {},
  ...extra,
});

const ctx = (extra: Partial<Parameters<typeof mensajeDePasada>[0]> = {}) => ({
  dia: "2026-09-14",
  dimensiones: [] as DimensionSalud[],
  deltas: [],
  pendientes: [],
  solicitudes: [],
  ...extra,
});

describe("promptDelContador", () => {
  it("fija los tres objetivos EN ORDEN y dice qué gana cuando chocan", () => {
    const p = promptDelContador({ razonSocial: "ACME", rfc: "AAA010101AAA", regimenFiscal: "601" }, HOY);
    expect(p.indexOf("Entregar la contabilidad")).toBeLessThan(p.indexOf("Proteger al cliente"));
    expect(p.indexOf("Proteger al cliente")).toBeLessThan(p.indexOf("Cumplir la ley"));
    expect(p).toContain("gana el de arriba");
  });

  it("prohíbe repetir lo que ya tiene compromiso o solicitud abierta", () => {
    const p = promptDelContador({ razonSocial: "ACME", rfc: "AAA010101AAA", regimenFiscal: "601" }, HOY);
    expect(p).toContain("No repitas lo que ya está dicho");
  });

  it("deja claro que proponer no es ejecutar", () => {
    const p = promptDelContador({ razonSocial: "ACME", rfc: "AAA010101AAA", regimenFiscal: "601" }, HOY);
    expect(p).toContain("Nunca digas que algo quedó hecho cuando sólo lo dejaste propuesto");
  });

  it("autoriza explícitamente cerrar sin novedad", () => {
    // Sin esto el modelo rellena con observaciones tibias para no volver vacío,
    // que es exactamente el ruido que este trabajo existe para eliminar.
    const p = promptDelContador({ razonSocial: "ACME", rfc: "AAA010101AAA", regimenFiscal: "601" }, HOY);
    expect(p).toContain("sin_novedad");
    expect(p).toContain("respuesta correcta y frecuente");
  });
});

describe("mensajeDePasada", () => {
  it("lo que bloquea va antes que lo que sólo necesita atención", () => {
    const m = mensajeDePasada(
      ctx({ dimensiones: [dim(), dim({ clave: "declaraciones", titulo: "Declaraciones", estado: "bloquea" })] }),
    );
    expect(m.indexOf("Bloqueando ahora mismo")).toBeLessThan(m.indexOf("sigue necesitando atención"));
  });

  it("los compromisos abiertos se marcan como NO reportables", () => {
    const m = mensajeDePasada(
      ctx({ pendientes: [{ titulo: "Falta el estado de cuenta", cuerpo: "Sin él no se cuadra.", desdeDias: 12 }] }),
    );
    expect(m).toContain("NO los vuelvas a reportar");
    expect(m).toContain("hace 12 días");
  });

  it("lo ya pedido al cliente se marca como NO re-pedible", () => {
    const m = mensajeDePasada(
      ctx({ solicitudes: [{ titulo: "Estado de cuenta de la terminal", periodo: "2026-07", desdeDias: 20 }] }),
    );
    expect(m).toContain("NO lo vuelvas a pedir");
  });

  it("una empresa sin nada que contar igual recibe el encargo, no un mensaje vacío", () => {
    const m = mensajeDePasada(ctx());
    expect(m).toContain("cerrar_pasada");
    expect(m).toContain("Atiende primero lo que impide ENTREGAR");
  });
});

describe("normalizarResumen", () => {
  const bueno = {
    estado: "pendiente",
    titulo: "Agosto sin conciliar",
    causa: "No se ha cargado el estado de cuenta de agosto.",
    accion: "Pedir el estado de cuenta y volver a correr la conciliación.",
    evidencia: ["tx_1", "tx_2"],
  };

  it("descarta el renglón sin causa: un síntoma solo es el ruido de siempre", () => {
    const r = normalizarResumen({ renglones: [{ ...bueno, causa: "" }] });
    expect(r.renglones).toHaveLength(0);
    expect(r.sinNovedad).toBe(true);
  });

  it("descarta el renglón sin acción", () => {
    expect(normalizarResumen({ renglones: [{ ...bueno, accion: "  " }] }).renglones).toHaveLength(0);
  });

  it("lo que hay que decidir va primero, lo ya atendido al final", () => {
    const r = normalizarResumen({
      renglones: [
        { ...bueno, estado: "atendido", titulo: "A" },
        { ...bueno, estado: "escalado", titulo: "B" },
        { ...bueno, estado: "pendiente", titulo: "C" },
      ],
    });
    expect(r.renglones.map((x) => x.titulo)).toEqual(["B", "C", "A"]);
  });

  it("«sin novedad» se DERIVA de no tener renglones, no de lo que diga el modelo", () => {
    // Si el modelo se contradice —dice que no hay novedad y entrega trabajo—
    // manda lo que hay, no lo que creyó hacer.
    const r = normalizarResumen({ sin_novedad: true, renglones: [bueno] });
    expect(r.sinNovedad).toBe(false);
    expect(r.renglones).toHaveLength(1);
  });

  it("un estado inventado cae en pendiente en vez de tumbar el resumen", () => {
    expect(normalizarResumen({ renglones: [{ ...bueno, estado: "inventado" }] }).renglones[0].estado).toBe("pendiente");
  });

  it("aguanta basura sin lanzar", () => {
    expect(normalizarResumen(null).sinNovedad).toBe(true);
    expect(normalizarResumen({ renglones: "no es arreglo" }).renglones).toEqual([]);
    expect(normalizarResumen({ renglones: [null, 3, "x"] }).renglones).toEqual([]);
  });

  it("acota la lista: un resumen de treinta puntos no se lee", () => {
    const muchos = Array.from({ length: 30 }, (_, i) => ({ ...bueno, titulo: `t${i}` }));
    expect(normalizarResumen({ renglones: muchos }).renglones.length).toBeLessThanOrEqual(12);
  });
});

describe("resumenEnTexto", () => {
  it("sin novedad lo dice en una línea, no con una plantilla vacía", () => {
    expect(resumenEnTexto({ renglones: [], sinNovedad: true })).toContain("sin novedad");
  });

  it("cada renglón sale con su causa, su acción y su evidencia", () => {
    const t = resumenEnTexto(
      normalizarResumen({
        renglones: [
          {
            estado: "escalado",
            titulo: "IVA sin prueba de pago",
            causa: "La empresa no concilia banco.",
            accion: "Decidir si se acredita o se difiere.",
            evidencia: ["inv_1"],
            fundamento: "Art. 5-I LIVA",
          },
        ],
      }),
    );
    expect(t).toContain("Causa:");
    expect(t).toContain("Acción:");
    expect(t).toContain("Fundamento: Art. 5-I LIVA");
    expect(t).toContain("inv_1");
  });
});

describe("cadencia y a quién le toca", () => {
  it("el plan decide cada cuánto se razona una empresa", () => {
    expect(cadenciaDePlan("PRO")).toBe("diaria");
    expect(cadenciaDePlan("DESPACHO")).toBe("diaria");
    expect(cadenciaDePlan("AUTOMATIZADO")).toBe("semanal");
    expect(cadenciaDePlan("ASISTENTE")).toBe("solo_eventos");
  });

  it("la semanal cae en lunes, cuando el cliente retoma el trabajo", () => {
    expect(tocaHoy("semanal", new Date("2026-09-14T12:00:00Z"))).toBe(true); // lunes
    expect(tocaHoy("semanal", new Date("2026-09-18T12:00:00Z"))).toBe(false); // viernes
  });

  it("«sólo eventos» nunca entra en la corrida diaria", () => {
    expect(tocaHoy("solo_eventos", HOY)).toBe(false);
    expect(tocaHoy("diaria", new Date("2026-09-18T12:00:00Z"))).toBe(true);
  });
});
