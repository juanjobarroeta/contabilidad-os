import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  entradasDeProtocolo,
  honorariosSugeridos,
  preciarPartidas,
  simularProtocolo,
  totalesSimulacion,
  type InsumoCosteado,
  type PartidaPreciada,
} from "./protocolo";

// ── Base falsa: sólo lo que armarPartidas / preciarPartidas / costearInsumos consultan ──

type ServicioFalso = { id: string; companyId: string; nombre: string; categoria: string; precioLista: number; ivaTasa: number | null; tarifas: Array<{ pagadorId: string; precio: number }> };
type InsumoFalso = { id: string; companyId: string; clave: string; nombre: string; unidad: string; presentacion: string | null; ultimoCosto: number | null };

function fakeDb(opts: { servicios: ServicioFalso[]; insumos?: InsumoFalso[]; ivaServicios?: number; protocolo?: Record<string, unknown>; pagadores?: Array<Record<string, unknown>> }) {
  const insumos = opts.insumos ?? [];
  return {
    hospServicio: {
      findMany: async (q: { where: { id: { in: string[] }; companyId: string }; include?: { tarifas: false | { where: { pagadorId: string } } } }) =>
        opts.servicios
          .filter((s) => q.where.id.in.includes(s.id) && s.companyId === q.where.companyId)
          .map((s) => ({ ...s, tarifas: q.include?.tarifas ? s.tarifas.filter((t) => t.pagadorId === (q.include!.tarifas as { where: { pagadorId: string } }).where.pagadorId) : undefined })),
    },
    hospConfig: { findUnique: async () => ({ ivaServicios: opts.ivaServicios ?? 0.16 }) },
    hospTarifa: {
      findMany: async (q: { where: { pagadorId: string; servicioId: { in: string[] } } }) =>
        opts.servicios.flatMap((s) =>
          s.tarifas.filter((t) => t.pagadorId === q.where.pagadorId && q.where.servicioId.in.includes(s.id)).map(() => ({ servicioId: s.id }))
        ),
    },
    hospInsumo: {
      findMany: async (q: { where: { id: { in: string[] }; companyId: string } }) => insumos.filter((i) => q.where.id.in.includes(i.id) && i.companyId === q.where.companyId),
    },
    hospProtocolo: { findUnique: async (q: { where: { id: string } }) => (opts.protocolo && opts.protocolo.id === q.where.id ? opts.protocolo : null) },
    hospPagador: { findUnique: async (q: { where: { id: string } }) => (opts.pagadores ?? []).find((p) => p.id === q.where.id) ?? null },
  } as unknown as PrismaClient;
}

const servicios: ServicioFalso[] = [
  { id: "s-hab", companyId: "c1", nombre: "Habitación estándar", categoria: "HABITACION", precioLista: 3200, ivaTasa: 0.16, tarifas: [{ pagadorId: "gnp", precio: 2900 }] },
  { id: "s-qx", companyId: "c1", nombre: "Quirófano por hora", categoria: "QUIROFANO", precioLista: 6000, ivaTasa: 0.16, tarifas: [] },
  { id: "s-lab", companyId: "c1", nombre: "Biometría hemática", categoria: "ESTUDIO", precioLista: 450, ivaTasa: 0.16, tarifas: [{ pagadorId: "gnp", precio: 380 }] },
];

const partidasProtocolo = [
  { servicioId: "s-hab", categoria: "HABITACION" as const, descripcion: "Habitación estándar", cantidad: 2, opcional: false },
  { servicioId: "s-qx", categoria: "QUIROFANO" as const, descripcion: "Quirófano", cantidad: 1.5, opcional: false },
  { servicioId: "s-lab", categoria: "ESTUDIO" as const, descripcion: "Biometría hemática", cantidad: 1, opcional: true },
  { servicioId: null, categoria: "MATERIAL" as const, descripcion: "Kit de laparoscopía", cantidad: 1, opcional: false },
];

describe("entradasDeProtocolo", () => {
  it("una partida sin servicio no tiene tarifa: precio 0 hasta que el piso lo capture", () => {
    const entradas = entradasDeProtocolo(partidasProtocolo);
    expect(entradas[0]).not.toHaveProperty("precioUnitario");
    expect(entradas[3].precioUnitario).toBe(0);
    expect(entradas[2].opcional).toBe(true);
    expect(entradas[1].cantidad).toBe(1.5);
  });
});

describe("preciarPartidas (convenio vs lista, misma regla que la cotización)", () => {
  it("con convenio usa la HospTarifa del pagador y cae a lista donde no hay tarifa", async () => {
    const db = fakeDb({ servicios });
    const r = await preciarPartidas(db, "c1", "gnp", entradasDeProtocolo(partidasProtocolo));
    expect(r.partidas.map((p) => [p.precioUnitario, p.origenPrecio])).toEqual([
      [2900, "CONVENIO"],
      [6000, "LISTA"],
      [380, "CONVENIO"],
      [0, "SIN_TARIFA"],
    ]);
    // 2 × 2900 + 1.5 × 6000 + 380 + 0
    expect(r.subtotal).toBe(15180);
    expect(r.iva).toBe(2428.8);
    expect(r.total).toBe(17608.8);
    expect(r.partidas[2].opcional).toBe(true);
    expect(r.partidas[0].iva).toBe(928);
    expect(r.partidas[0].total).toBe(6728);
  });

  it("sin pagador todo va a precio de lista", async () => {
    const db = fakeDb({ servicios });
    const r = await preciarPartidas(db, "c1", null, entradasDeProtocolo(partidasProtocolo));
    expect(r.partidas.map((p) => [p.precioUnitario, p.origenPrecio])).toEqual([
      [3200, "LISTA"],
      [6000, "LISTA"],
      [450, "LISTA"],
      [0, "SIN_TARIFA"],
    ]);
    expect(r.subtotal).toBe(15850);
  });

  it("un precio explícito del piso manda y se marca MANUAL", async () => {
    const db = fakeDb({ servicios });
    const r = await preciarPartidas(db, "c1", "gnp", [
      { servicioId: "s-hab", cantidad: 1, precioUnitario: 2500 },
      { categoria: "MATERIAL", descripcion: "Kit de laparoscopía", cantidad: 1, precioUnitario: 8000 },
    ]);
    expect(r.partidas.map((p) => [p.precioUnitario, p.origenPrecio, p.ivaTasa])).toEqual([
      [2500, "MANUAL", 0.16],
      [8000, "MANUAL", 0.16],
    ]);
  });

  it("un servicio de otra empresa se rechaza", async () => {
    const db = fakeDb({ servicios });
    await expect(preciarPartidas(db, "c2", "gnp", [{ servicioId: "s-hab", cantidad: 1 }])).rejects.toThrow(/servicioId inválido/);
  });
});

describe("honorariosSugeridos", () => {
  it("cirujano con monto; anestesiólogo cuando tiene monto o el protocolo lo exige", () => {
    expect(honorariosSugeridos({ honorarioCirujano: 25000, honorarioAnestesiologo: null, requiereAnestesiologo: false })).toEqual([{ rol: "CIRUJANO", monto: 25000 }]);
    expect(honorariosSugeridos({ honorarioCirujano: 25000, honorarioAnestesiologo: 8000, requiereAnestesiologo: true })).toEqual([
      { rol: "CIRUJANO", monto: 25000 },
      { rol: "ANESTESIOLOGO", monto: 8000 },
    ]);
    expect(honorariosSugeridos({ honorarioCirujano: null, honorarioAnestesiologo: null, requiereAnestesiologo: true })).toEqual([{ rol: "ANESTESIOLOGO", monto: 0 }]);
    expect(honorariosSugeridos({ honorarioCirujano: null, honorarioAnestesiologo: null, requiereAnestesiologo: false })).toEqual([]);
  });
});

describe("totalesSimulacion", () => {
  const partida = (importe: number, ivaTasa: number | null, opcional = false): PartidaPreciada => ({
    orden: 0,
    servicioId: null,
    categoria: "OTRO",
    descripcion: "x",
    cantidad: 1,
    precioUnitario: importe,
    ivaTasa,
    importe,
    iva: ivaTasa == null ? 0 : Math.round(importe * ivaTasa * 100) / 100,
    total: ivaTasa == null ? importe : importe + Math.round(importe * ivaTasa * 100) / 100,
    opcional,
    origenPrecio: "LISTA",
  });
  const insumo = (costo: number, opcional = false): InsumoCosteado => ({ insumoId: "i", clave: "I", nombre: "i", unidad: "pz", presentacion: null, cantidad: 1, opcional, costoUnitario: costo, costo });

  it("separa opcionales, suma honorarios exentos y costea insumos", () => {
    const t = totalesSimulacion([partida(1000, 0.16), partida(500, null), partida(300, 0.16, true)], [{ rol: "CIRUJANO", monto: 2000 }], [insumo(120), insumo(80, true)]);
    expect(t.subtotal).toBe(1800);
    expect(t.iva).toBe(208);
    expect(t.total).toBe(2008);
    expect(t.honorarios).toBe(2000);
    expect(t.totalConHonorarios).toBe(4008);
    expect(t.costoInsumos).toBe(200);
    expect(t.sinOpcionales).toEqual({ subtotal: 1500, iva: 160, total: 1660, totalConHonorarios: 3660, costoInsumos: 120 });
  });
});

describe("simularProtocolo", () => {
  const protocolo = {
    id: "p1",
    companyId: "c1",
    clave: "COLE-LAP",
    nombre: "Colecistectomía laparoscópica",
    version: 2,
    tipoEpisodio: "AMBULATORIO",
    estanciaNoches: 1,
    quirofanoMinutos: 90,
    tipoAnestesia: 1,
    requiereAnestesiologo: true,
    honorarioCirujano: 25000,
    honorarioAnestesiologo: 8000,
    partidas: partidasProtocolo,
    insumos: [
      { insumoId: "i-propofol", cantidad: 2, opcional: false },
      { insumoId: "i-gasa", cantidad: 10, opcional: true },
    ],
  };
  const insumos: InsumoFalso[] = [
    { id: "i-propofol", companyId: "c1", clave: "PROP", nombre: "Propofol 200 mg", unidad: "ampolleta", presentacion: null, ultimoCosto: 85.5 },
    { id: "i-gasa", companyId: "c1", clave: "GASA", nombre: "Gasa estéril", unidad: "pieza", presentacion: null, ultimoCosto: null },
  ];

  it("precia con el convenio, sugiere honorarios y costea insumos al último costo", async () => {
    const db = fakeDb({ servicios, insumos, protocolo, pagadores: [{ id: "gnp", companyId: "c1", nombre: "GNP Seguros", tipo: "ASEGURADORA", tabulador: "GNP 2026" }] });
    const s = await simularProtocolo(db, { companyId: "c1", protocoloId: "p1", pagadorId: "gnp" });
    expect(s.protocolo).toMatchObject({ clave: "COLE-LAP", quirofanoMinutos: 90, requiereAnestesiologo: true });
    expect(s.pagador?.nombre).toBe("GNP Seguros");
    expect(s.partidas.map((p) => p.origenPrecio)).toEqual(["CONVENIO", "LISTA", "CONVENIO", "SIN_TARIFA"]);
    expect(s.honorarios).toEqual([
      { rol: "CIRUJANO", monto: 25000 },
      { rol: "ANESTESIOLOGO", monto: 8000 },
    ]);
    expect(s.insumos.map((i) => [i.nombre, i.costoUnitario, i.costo, i.opcional])).toEqual([
      ["Propofol 200 mg", 85.5, 171, false],
      ["Gasa estéril", null, 0, true],
    ]);
    expect(s.totales.total).toBe(17608.8);
    expect(s.totales.totalConHonorarios).toBe(50608.8);
    expect(s.totales.costoInsumos).toBe(171);
    expect(s.totales.sinOpcionales.subtotal).toBe(14800);
  });

  it("404 si el protocolo es de otra empresa; 400 si el pagador no es de la empresa", async () => {
    const db = fakeDb({ servicios, insumos, protocolo, pagadores: [{ id: "axa", companyId: "c9", nombre: "AXA", tipo: "ASEGURADORA", tabulador: null }] });
    await expect(simularProtocolo(db, { companyId: "c2", protocoloId: "p1" })).rejects.toMatchObject({ status: 404 });
    await expect(simularProtocolo(db, { companyId: "c1", protocoloId: "p1", pagadorId: "axa" })).rejects.toMatchObject({ status: 400 });
  });
});
