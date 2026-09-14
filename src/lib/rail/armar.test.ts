import { describe, it, expect } from "vitest";
import { armarRail, comoRevision, esperaEnTexto, UMBRAL_REVISION, type EntradaRail } from "./armar";
import type { GrupoRail } from "@/lib/hallazgos/agrupar";
import type { DimensionSalud } from "@/lib/salud/evaluar";
import type { RenglonResumen } from "@/lib/contador/claves";

const grupo = (extra: Partial<GrupoRail> = {}): GrupoRail => ({
  href: "/facturas?dup=1",
  verbo: "Revisar duplicados",
  severidad: "warn",
  count: 3,
  ids: ["h1"],
  titulo: "3 CFDIs por revisar",
  muestra: "Factura A-100 aparece dos veces",
  categoria: "cfdi",
  ...extra,
});

const renglon = (extra: Partial<RenglonResumen> = {}): RenglonResumen => ({
  estado: "atendido",
  titulo: "Conciliados 12 movimientos de agosto",
  causa: "Llegó el estado de cuenta.",
  accion: "Se corrió la conciliación.",
  evidencia: [],
  fundamento: null,
  ...extra,
});

const dim = (extra: Partial<DimensionSalud> = {}): DimensionSalud => ({
  clave: "bancos",
  titulo: "Bancos",
  estado: "atencion",
  detalle: "40 movimientos sin conciliar.",
  metricas: {},
  ...extra,
});

const entrada = (extra: Partial<EntradaRail> = {}): EntradaRail => ({
  renglones: [],
  ultimaPasada: null,
  solicitudes: [],
  dimensiones: [],
  deltas: [],
  grupos: [],
  ...extra,
});

describe("comoRevision — la regla dura contra el conteo crudo", () => {
  it("un grupo enorme deja de ser lista y pasa a ser revisión", () => {
    // Es el caso de los 13,778 posibles duplicados: a ese volumen el número
    // ya no informa, informa que el check está marcando un patrón normal.
    const r = comoRevision(grupo({ count: 13778, titulo: "13,778 CFDIs por revisar" }));
    expect(r).not.toBeNull();
    expect(r!.casos).toBe(13778);
    expect(r!.triage).toContain("demasiados para atenderlos uno por uno");
    expect(r!.triage).toContain("patrón normal del negocio");
  });

  it("un grupo pequeño NO es una revisión: es trabajo que sí se puede hacer", () => {
    expect(comoRevision(grupo({ count: 3 }))).toBeNull();
    expect(comoRevision(grupo({ count: UMBRAL_REVISION - 1 }))).toBeNull();
    expect(comoRevision(grupo({ count: UMBRAL_REVISION }))).not.toBeNull();
  });

  it("la revisión lleva muestra: sin ejemplos nadie puede juzgar si el check acierta", () => {
    expect(comoRevision(grupo({ count: 500 }))!.muestra).toEqual(["Factura A-100 aparece dos veces"]);
  });
});

describe("armarRail — lo que hice", () => {
  it("sólo entra lo ATENDIDO: un «lo que hice» con pendientes es la lista de problemas otra vez", () => {
    const r = armarRail(
      entrada({
        renglones: [
          renglon(),
          renglon({ estado: "pendiente", titulo: "Falta agosto" }),
          renglon({ estado: "escalado", titulo: "Decidir IVA" }),
        ],
      }),
    );
    expect(r.hice.map((h) => h.texto)).toEqual(["Conciliados 12 movimientos de agosto"]);
  });

  it("sin pasada todavía, el bloque va vacío y se dice cuándo fue la última", () => {
    const r = armarRail(entrada());
    expect(r.hice).toEqual([]);
    expect(r.ultimaPasada).toBeNull();
  });
});

describe("armarRail — lo que necesito de ti", () => {
  it("lo que una persona debe DECIDIR va antes que lo pedido al cliente", () => {
    const r = armarRail(
      entrada({
        renglones: [renglon({ estado: "escalado", titulo: "Decidir si se acredita el IVA" })],
        solicitudes: [
          { id: "s1", tipo: "estado_cuenta_terminal", motivo: "Falta el reporte.", periodo: "2026-07", dias: 30 },
        ],
      }),
    );
    expect(r.necesito[0].titulo).toBe("Decidir si se acredita el IVA");
    expect(r.necesito[1].titulo).toContain("Estado de cuenta de la terminal");
  });

  it("entre pedidos, el que más ha esperado va primero", () => {
    const r = armarRail(
      entrada({
        solicitudes: [
          { id: "nuevo", tipo: "comprobante", motivo: "x", periodo: null, dias: 2 },
          { id: "viejo", tipo: "comprobante", motivo: "y", periodo: null, dias: 40 },
        ],
      }),
    );
    expect(r.necesito.map((p) => p.id)).toEqual(["viejo", "nuevo"]);
  });

  it("un grupo enorme NO entra como trabajo: saldría como una tarea imposible", () => {
    const r = armarRail(entrada({ grupos: [grupo({ count: 13778 })] }));
    expect(r.necesito).toEqual([]);
    expect(r.revisiones).toHaveLength(1);
  });

  it("un grupo chico SÍ entra como trabajo concreto", () => {
    const r = armarRail(entrada({ grupos: [grupo({ count: 3 })] }));
    expect(r.necesito).toHaveLength(1);
    expect(r.revisiones).toEqual([]);
  });

  it("no crece sin límite: un rail con scroll ya falló", () => {
    const muchas = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`,
      tipo: "comprobante" as const,
      motivo: "x",
      periodo: null,
      dias: i,
    }));
    expect(armarRail(entrada({ solicitudes: muchas })).necesito.length).toBeLessThanOrEqual(5);
  });
});

describe("armarRail — cómo vamos", () => {
  it("las dimensiones salen en el orden de atención, no en el que llegaron", () => {
    const r = armarRail(
      entrada({
        dimensiones: [dim(), dim({ clave: "declaraciones", titulo: "Declaraciones", estado: "bloquea" })],
      }),
    );
    expect(r.vamos.map((d) => d.clave)).toEqual(["declaraciones", "bancos"]);
  });

  it("una dimensión que está bien NO desaparece: si no, «mejoró» y «ya no se mide» serían iguales", () => {
    const r = armarRail(entrada({ dimensiones: [dim({ estado: "ok", detalle: "Todo conciliado." })] }));
    expect(r.vamos).toHaveLength(1);
    expect(r.vamos[0].estado).toBe("ok");
  });

  it("el cambio del día se anota junto a la dimensión que cambió", () => {
    const r = armarRail(
      entrada({
        dimensiones: [dim()],
        deltas: [
          {
            clave: "bancos",
            titulo: "Bancos",
            deltaKey: "bancos.empeoro",
            direccion: "empeoro",
            de: "ok",
            a: "atencion",
            detalle: "x",
          },
        ],
      }),
    );
    expect(r.vamos[0].cambio).toBe("ok → atencion");
  });

  it("una dimensión sin cambio no inventa uno", () => {
    expect(armarRail(entrada({ dimensiones: [dim()] })).vamos[0].cambio).toBeNull();
  });
});

describe("esperaEnTexto", () => {
  it("un pedido viejo se dice como espera, no como fecha", () => {
    expect(esperaEnTexto(30)).toContain("30 días esperando");
    expect(esperaEnTexto(0)).toBe("pedido hoy");
    expect(esperaEnTexto(5)).toBe("pedido hace 5 días");
  });
});
