import { describe, expect, it } from "vitest";
import {
  ejecutarPresentacion,
  esRutaInterna,
  sanearAccion,
  sanearRef,
  sanearTarjeta,
  sanearTarjetas,
  MAX_ACCIONES,
  MAX_FILAS,
} from "./tarjetas";
import { acotarMascota, colocarJunto, esquinaMascota, miradaPupila } from "./colocar";
import { sugerenciasPara, tituloDeRuta } from "./sugerencias";
import { accionesPara, CacheExplicaciones, llaveExplicacion, promptExplicacion } from "./explicar";
import { pasosHechos } from "@/components/ai/useChat";

describe("tarjetas: saneado", () => {
  it("acepta una cifra con filas {k,v} y las normaliza a pares", () => {
    const c = sanearTarjeta({
      type: "cifra",
      etiqueta: "IVA a cargo · septiembre",
      valor: "$26,667",
      filas: [{ k: "Trasladado", v: "$28,512" }, ["Acreditable", "−$1,845"]],
    });
    expect(c).toEqual({
      type: "cifra",
      etiqueta: "IVA a cargo · septiembre",
      valor: "$26,667",
      filas: [
        ["Trasladado", "$28,512"],
        ["Acreditable", "−$1,845"],
      ],
    });
  });

  it("descarta tarjetas sin lo mínimo para pintarse", () => {
    expect(sanearTarjeta({ type: "cifra", etiqueta: "IVA" })).toBeNull();
    expect(sanearTarjeta({ type: "lista", items: [{ sub: "sin título" }] })).toBeNull();
    expect(sanearTarjeta({ type: "desconocida" })).toBeNull();
    expect(sanearTarjeta(null)).toBeNull();
  });

  it("acota filas y cae a tono slate si el tono no existe", () => {
    const filas = Array.from({ length: 20 }, (_, i) => [`k${i}`, `v${i}`]);
    const c = sanearTarjeta({ type: "obligacion", titulo: "DIOT", tono: "morado", estatus: "Vencida", filas });
    expect(c?.type).toBe("obligacion");
    if (c?.type !== "obligacion") throw new Error();
    expect(c.tono).toBe("slate");
    expect(c.filas).toHaveLength(MAX_FILAS);
  });

  it("pasos acepta `pasos` (lo que pide la tool) o `items` (lo que se guarda)", () => {
    expect(sanearTarjeta({ type: "pasos", pasos: ["Leer CFDIs", "Agrupar"] })).toEqual({ type: "pasos", items: ["Leer CFDIs", "Agrupar"] });
    expect(sanearTarjeta({ type: "pasos", items: ["Uno"] })).toEqual({ type: "pasos", items: ["Uno"] });
  });

  it("sanearTarjetas filtra lo inválido de lo guardado", () => {
    expect(sanearTarjetas([{ type: "memoria", texto: "Avisarte 3 días antes" }, { type: "x" }, "basura"])).toEqual([
      { type: "memoria", texto: "Avisarte 3 días antes" },
    ]);
    expect(sanearTarjetas("no es lista")).toEqual([]);
  });
});

describe("tarjetas: acciones", () => {
  it("sólo navega a rutas internas", () => {
    expect(esRutaInterna("/cumplimiento")).toBe(true);
    expect(esRutaInterna("/bancos?tab=historico")).toBe(true);
    expect(esRutaInterna("//evil.com")).toBe(false);
    expect(esRutaInterna("https://evil.com")).toBe(false);
    expect(esRutaInterna("javascript:alert(1)")).toBe(false);
    expect(esRutaInterna("/a b")).toBe(false);
    expect(sanearAccion({ label: "Ver", kind: "navegar", href: "https://x.com" })).toBeNull();
  });

  it("un turno necesita seed; navegar lleva flecha por defecto", () => {
    expect(sanearAccion({ label: "Preparar", kind: "turno" })).toBeNull();
    expect(sanearAccion({ label: "Preparar DIOT", kind: "turno", seed: "Prepara la DIOT", icon: "zap", primary: true })).toEqual({
      label: "Preparar DIOT",
      kind: "turno",
      seed: "Prepara la DIOT",
      icon: "zap",
      primary: true,
    });
    expect(sanearAccion({ label: "Ver", kind: "navegar", href: "/cumplimiento" })?.icon).toBe("arrow");
  });

  it("ofrecer_acciones acota a 3 y avisa al modelo si no quedó nada", () => {
    const muchas = Array.from({ length: 6 }, (_, i) => ({ label: `A${i}`, kind: "turno", seed: `s${i}` }));
    const r = ejecutarPresentacion("ofrecer_acciones", { acciones: muchas });
    expect(r.card?.type).toBe("acciones");
    if (r.card?.type !== "acciones") throw new Error();
    expect(r.card.acciones).toHaveLength(MAX_ACCIONES);
    const vacio = ejecutarPresentacion("ofrecer_acciones", { acciones: [{ label: "x", kind: "otro" }] });
    expect(vacio.card).toBeNull();
    expect(JSON.parse(vacio.resultado).error).toBeTruthy();
  });

  it("mostrar_tarjeta usa `tipo` como type", () => {
    const r = ejecutarPresentacion("mostrar_tarjeta", { tipo: "hecho", titulo: "DIOT lista", filas: [{ k: "Proveedores", v: "14" }] });
    expect(r.card).toEqual({ type: "hecho", titulo: "DIOT lista", filas: [["Proveedores", "14"]] });
    expect(JSON.parse(r.resultado)).toEqual({ ok: true, mostrada: "hecho" });
  });
});

describe("tarjetas: referencia", () => {
  it("valida el tipo y acota los datos", () => {
    expect(sanearRef({ tipo: "otro", id: "1", titulo: "x" })).toBeNull();
    expect(sanearRef({ tipo: "factura", id: "", titulo: "x" })).toBeNull();
    const r = sanearRef({
      tipo: "obligacion_mes",
      id: "DIOT:2026-09",
      titulo: "DIOT · septiembre",
      datos: { estatus: "vencida", vacio: "", n: 3 },
      ruta: "//evil",
    });
    expect(r).toEqual({ tipo: "obligacion_mes", id: "DIOT:2026-09", titulo: "DIOT · septiembre", datos: { estatus: "vencida", n: "3" } });
  });
});

describe("colocar", () => {
  const vw = 1440;
  const vh = 900;
  it("abre hacia la izquierda si la mascota está a la derecha", () => {
    const m = { left: 1350, top: 800, width: 58, height: 58 };
    const { x, y } = colocarJunto(m, 400, 600, vw, vh, "panel");
    expect(x).toBe(1350 - 400 - 12);
    expect(y).toBe(800 + 58 - 600);
  });
  it("abre a la derecha si está a la izquierda; la burbuja se alinea arriba", () => {
    const m = { left: 40, top: 300, width: 58, height: 58 };
    expect(colocarJunto(m, 290, 120, vw, vh, "burbuja")).toEqual({ x: 40 + 58 + 12, y: 296 });
  });
  it("sin espacio de lado, centra encima (o debajo) y respeta 12px", () => {
    const m = { left: 180, top: 20, width: 58, height: 58 };
    const { x, y } = colocarJunto(m, 380, 200, 400, 800, "burbuja");
    expect(x).toBe(12);
    expect(y).toBe(20 + 58 + 12);
  });
  it("acota la mascota a 8px de los bordes y la esquina es 28px", () => {
    expect(acotarMascota(-50, 5000, vw, vh)).toEqual({ x: 8, y: vh - 58 - 8 });
    expect(esquinaMascota(vw, vh)).toEqual({ x: vw - 58 - 28, y: vh - 58 - 28 });
  });
  it("las pupilas no pasan de 2.5×3.5 px", () => {
    const lejos = miradaPupila(0, 0, 1000, 0);
    expect(lejos.dx).toBeCloseTo(2.5);
    expect(lejos.dy).toBeCloseTo(0);
    const cerca = miradaPupila(0, 0, 0, 90);
    expect(cerca.dy).toBeCloseTo(3.5 * 0.5);
  });
});

describe("sugerencias", () => {
  it("pone primero lo que el rail necesita, como acciones", () => {
    const s = sugerenciasPara("/impuestos", [{ id: "p1", titulo: "Estado de cuenta de la terminal", detalle: "Falta septiembre" }]);
    expect(s[0]).toMatchObject({ tipo: "accion", texto: "Estado de cuenta de la terminal" });
    expect(s.map((x) => x.texto)).toContain("¿Por qué debo este IVA?");
  });
  it("cae a la sugerencia por defecto en rutas sin preguntas", () => {
    expect(sugerenciasPara("/configuracion").map((x) => x.texto)).toEqual(["Resumen del mes"]);
  });
  it("respeta subrutas y el tope", () => {
    expect(sugerenciasPara("/contabilidad/polizas").length).toBeGreaterThan(0);
    const necesito = Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, titulo: `P${i}`, detalle: "" }));
    expect(sugerenciasPara("/dashboard", necesito, 3)).toHaveLength(3);
  });
  it("titula la ruta por el destino más específico", () => {
    expect(tituloDeRuta("/impuestos/papeles")).toBe("Papeles de trabajo");
    expect(tituloDeRuta("/impuestos?tab=iva")).toBe("Impuestos");
  });
});

describe("explicar", () => {
  it("DIOT vencida → Preparar DIOT; 69-B → Armar expediente; sin CFDI → Pedir CFDI", () => {
    expect(accionesPara({ tipo: "obligacion_mes", id: "DIOT:2026-08", titulo: "DIOT · agosto", datos: { estatus: "vencida" } })[0].label).toBe(
      "Preparar DIOT",
    );
    expect(accionesPara({ tipo: "hallazgo", id: "h1", titulo: "Proveedor en lista 69-B" })[0].label).toBe("Armar expediente");
    expect(accionesPara({ tipo: "movimiento", id: "m1", titulo: "SPEI", datos: { estatus: "sin conciliar, sin CFDI" } })[0].label).toBe(
      "Pedir CFDI",
    );
    expect(accionesPara({ tipo: "obligacion_mes", id: "IVA:2026-08", titulo: "IVA · agosto", datos: { estatus: "presentada" } })).toEqual([]);
  });
  it("todas las acciones son turnos o navegación, nunca escrituras", () => {
    for (const a of accionesPara({ tipo: "kpi", id: "iva", titulo: "IVA" })) expect(["turno", "navegar"]).toContain(a.kind);
  });
  it("la llave cambia con updatedAt (o con lo que se ve)", () => {
    const base = { tipo: "factura" as const, id: "f1", titulo: "F" };
    expect(llaveExplicacion("c", { ...base, updatedAt: "1" })).not.toBe(llaveExplicacion("c", { ...base, updatedAt: "2" }));
    expect(llaveExplicacion("c", { ...base, datos: { estatus: "a" } })).not.toBe(llaveExplicacion("c", { ...base, datos: { estatus: "b" } }));
  });
  it("el prompt lleva lo visible y el registro", () => {
    const p = promptExplicacion({ tipo: "factura", id: "f1", titulo: "Ingreso · ACME", datos: { total: "100" } }, { status: "STAMPED" }, "/facturas");
    expect(p).toContain("Ingreso · ACME");
    expect(p).toContain("total: 100");
    expect(p).toContain("STAMPED");
  });
  it("la caché vence y respeta el tope", () => {
    const c = new CacheExplicaciones<number>(1000, 2);
    c.set("a", 1, 0);
    c.set("b", 2, 0);
    c.set("c", 3, 0);
    expect(c.get("a", 1)).toBeUndefined();
    expect(c.get("c", 1)).toBe(3);
    expect(c.get("c", 2000)).toBeUndefined();
  });
});

describe("pasos en vivo", () => {
  it("avanzan con cada herramienta y se cierran al terminar", () => {
    expect(pasosHechos(3, 0)).toBe(0);
    expect(pasosHechos(3, 1)).toBe(0);
    expect(pasosHechos(3, 2)).toBe(1);
    expect(pasosHechos(3, 10)).toBe(2);
    expect(pasosHechos(3, null)).toBe(3);
  });
});
