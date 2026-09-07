import { describe, it, expect } from "vitest";
import { quedoStaged, TIPO_DE_TOOL, toolsAProbar } from "./acciones";
import type { PasoConDecision } from "./evaluar";

function paso(over: Partial<PasoConDecision> = {}): PasoConDecision {
  return {
    clave: "apertura",
    titulo: "Punto de partida",
    descripcion: "",
    orden: 0,
    estadoCalculado: "atencion",
    detalle: null,
    senales: [],
    cifras: {},
    hechos: {},
    hashEvidencia: "h",
    cta: { label: "", href: "" },
    requiereConfirmacion: true,
    estado: "PENDIENTE",
    confirmadoAt: null,
    confirmadoByUserId: null,
    nota: null,
    ...over,
  } as PasoConDecision;
}

describe("toolsAProbar — qué tarjeta puede poner el paso solo", () => {
  it("propone fijar el coeficiente cuando su señal está en amarillo", () => {
    const p = paso({ senales: [{ clave: "x:coeficiente", estado: "warn", resumen: "sin coeficiente" }] });
    expect(toolsAProbar(p)).toEqual(["proponer_fijar_coeficiente"]);
  });

  it("propone firmar la conciliación en el paso de bancos", () => {
    const p = paso({
      clave: "banco",
      senales: [{ clave: "x:firmas_conciliacion", estado: "warn", resumen: "0 de 1 firmada" }],
    });
    expect(toolsAProbar(p)).toEqual(["proponer_firmar_conciliacion"]);
  });

  it("no propone nada cuando la señal ya está en ok", () => {
    const p = paso({ senales: [{ clave: "x:coeficiente", estado: "ok", resumen: "fijado" }] });
    expect(toolsAProbar(p)).toEqual([]);
  });

  it("no propone nada sobre un paso ya decidido por el humano", () => {
    const p = paso({
      estado: "CONFIRMADO",
      senales: [{ clave: "x:coeficiente", estado: "warn", resumen: "sin coeficiente" }],
    });
    expect(toolsAProbar(p)).toEqual([]);
  });

  it("no propone nada mientras el paso espera a otro", () => {
    const p = paso({
      estadoCalculado: "espera",
      senales: [{ clave: "x:coeficiente", estado: "warn", resumen: "sin coeficiente" }],
    });
    expect(toolsAProbar(p)).toEqual([]);
  });

  it("cada candidata tiene su tipo de pending action mapeado", () => {
    const todas = [
      ...toolsAProbar(paso({ senales: [{ clave: "x:coeficiente", estado: "warn", resumen: "" }] })),
      ...toolsAProbar(paso({ senales: [{ clave: "x:datos_apertura", estado: "warn", resumen: "" }] })),
      ...toolsAProbar(paso({ senales: [{ clave: "fx:apertura", estado: "warn", resumen: "" }] })),
      ...toolsAProbar(paso({ clave: "banco", senales: [{ clave: "x:firmas_conciliacion", estado: "warn", resumen: "" }] })),
    ];
    expect(todas.length).toBeGreaterThan(0);
    for (const t of todas) expect(TIPO_DE_TOOL[t]).toBeTruthy();
  });
});

describe("quedoStaged", () => {
  it("reconoce la propuesta puesta y descarta el rechazo", () => {
    expect(quedoStaged(JSON.stringify({ staged: true, summary: "x" }))).toBe(true);
    expect(quedoStaged(JSON.stringify({ error: "no procede" }))).toBe(false);
    expect(quedoStaged("no es json")).toBe(false);
  });
});
