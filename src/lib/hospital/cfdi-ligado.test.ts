import { describe, it, expect } from "vitest";
import {
  clavesProveedor,
  emparejarConOrden,
  ligarCfdiCompra,
  ligarLineaManual,
  similitud,
  sugerir,
  type LineaParaLigar,
  type PartidaDeOrden,
} from "./cfdi-ligado";
import { derivarInsumosDesdeCfdi } from "./insumos-cfdi";

// ─────────────────────────────────────────────────────────────────────────────
// La requisición se liga a la factura y se rastrea por inventario: el CFDI ya
// no crea insumos ni kardex; cada renglón se liga al catálogo físico por la
// orden, por lo aprendido del proveedor o a mano.
// ─────────────────────────────────────────────────────────────────────────────

const P = (id: string, insumo: string, descripcion: string, cantidad: number, precio: number, clave = insumo.toUpperCase()): PartidaDeOrden => ({
  id, hospInsumoId: insumo, descripcion, cantidad, precioUnitario: precio, insumoNombre: descripcion, insumoClave: clave,
});
const L = (llave: string, descripcion: string, cantidad: number, importe: number, extra: Partial<LineaParaLigar> = {}): LineaParaLigar => ({
  llave, descripcion, noIdentificacion: null, cantidad, importe, esInsumo: true, ...extra,
});

describe("similitud / claves", () => {
  it("palabras con significado, sin relleno ni acentos", () => {
    expect(similitud("CEFALOTINA 1 G SOL. INY. C/1 PZA", "Cefalotina 1 g solución inyectable")).toBeGreaterThan(0.4);
    expect(similitud("GASA ESTERIL 10X10", "Jeringa 5 ml")).toBe(0);
  });
  it("NI del proveedor cuando lo trae, y siempre la descripción", () => {
    expect(clavesProveedor("abc-12", "Gasa estéril")).toEqual(["NI:ABC-12", "D:GASA ESTERIL"]);
    expect(clavesProveedor(null, "Gasa estéril")).toEqual(["D:GASA ESTERIL"]);
  });
  it("sugerencias del catálogo por parecido", () => {
    const cat = [{ id: "a", clave: "M1", nombre: "Cefalotina 1 g" }, { id: "b", clave: "M2", nombre: "Gasa estéril" }];
    expect(sugerir("CEFALOTINA 1G SOL INY", cat).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("emparejarConOrden", () => {
  const orden = [
    P("p1", "cef", "Cefalotina 1 g sol. iny.", 50, 18.5),
    P("p2", "gasa", "Gasa estéril 10x10", 100, 2),
    P("p3", "jer", "Jeringa 5 ml", 200, 1.2),
  ];

  it("cada renglón a su línea por descripción, cantidad e importe", () => {
    const m = emparejarConOrden(
      [L("a", "CEFALOTINA 1 G SOLUCION INYECTABLE", 50, 925), L("b", "GASA ESTERIL 10 X 10 CM", 100, 200), L("c", "JERINGA DESECHABLE 5ML", 200, 240)],
      orden
    );
    expect(Object.fromEntries([...m].map(([k, p]) => [k, p.id]))).toEqual({ a: "p1", b: "p2", c: "p3" });
  });

  it("la clave del proveedor igual a la del insumo basta", () => {
    const m = emparejarConOrden([L("a", "ART 7788", 3, 30, { noIdentificacion: "cef" })], orden);
    expect(m.get("a")?.id).toBe("p1");
  });

  it("descripción floja: sólo con cantidad Y precio", () => {
    const orden2 = [P("p1", "cef", "Cefalotina 1 g", 50, 18.5), P("p2", "amk", "Amikacina 500 mg", 10, 30)];
    expect(emparejarConOrden([L("a", "CEFALOTINA SODICA AMPULA FRASCO", 50, 925)], orden2).get("a")?.id).toBe("p1");
    // Misma descripción floja, ni cantidad ni precio: con dos líneas libres no se adivina.
    expect(emparejarConOrden([L("a", "CEFALOTINA SODICA AMPULA FRASCO", 7, 999)], orden2).size).toBe(0);
  });

  it("un renglón y una línea sobrantes van juntos si algo lo respalda; un flete nunca", () => {
    const una = [P("p1", "cef", "Cefalotina 1 g", 50, 18.5)];
    expect(emparejarConOrden([L("a", "KEFLIN AMP", 50, 1000)], una).get("a")?.id).toBe("p1");
    expect(emparejarConOrden([L("f", "FLETE", 50, 925, { esInsumo: false })], una).size).toBe(0);
  });

  it("empate entre dos insumos distintos: a la cola", () => {
    const dos = [P("p1", "g1", "Gasa estéril 10x10", 100, 2), P("p2", "g2", "Gasa estéril 10x10", 100, 2)];
    expect(emparejarConOrden([L("a", "GASA ESTERIL 10X10", 100, 200)], dos).size).toBe(0);
  });

  it("el proveedor partió una línea en dos renglones (dos lotes): ambos a la misma línea", () => {
    const m = emparejarConOrden([L("a", "CEFALOTINA 1 G SOL INY LOTE A", 30, 555), L("b", "CEFALOTINA 1 G SOL INY LOTE B", 20, 370)], orden);
    expect(m.get("a")?.id).toBe("p1");
    expect(m.get("b")?.id).toBe("p1");
  });
});

// ─── Con un Prisma falso ─────────────────────────────────────────────────────

type Row = Record<string, any>;

function fakeDb(seed: { invoices: Row[]; vinculos?: Row[]; adjs?: Row[]; aprendido?: Row[]; insumos?: Row[]; crea?: boolean }) {
  const lineas: Row[] = [];
  const aprendido = seed.aprendido ?? [];
  const insumos = seed.insumos ?? [];
  let seq = 1;
  const db: any = {
    _lineas: lineas,
    _aprendido: aprendido,
    hospConfig: { findUnique: async () => ({ cfdiCreaInventario: seed.crea ?? false }) },
    invoice: { findFirst: async ({ where }: any) => seed.invoices.find((i) => i.id === where.id && i.companyId === where.companyId) ?? null },
    construccionCfdiVinculo: { findUnique: async ({ where }: any) => (seed.vinculos ?? []).find((v) => v.invoiceId === where.invoiceId) ?? null },
    solicitudAdjudicacion: { findFirst: async ({ where }: any) => (seed.adjs ?? []).find((a) => a.id === where.id) ?? null },
    hospProveedorInsumo: {
      findMany: async ({ where }: any) => aprendido.filter((a) => a.proveedorRfc === where.proveedorRfc && where.claveProveedor.in.includes(a.claveProveedor)),
      upsert: async ({ where, create, update }: any) => {
        const k = where.companyId_proveedorRfc_claveProveedor;
        const a = aprendido.find((x) => x.proveedorRfc === k.proveedorRfc && x.claveProveedor === k.claveProveedor);
        if (a) Object.assign(a, update);
        else aprendido.push({ ...create });
      },
    },
    hospInsumo: {
      findFirst: async ({ where }: any) => insumos.find((i) => i.id === where.id && i.companyId === where.companyId && i.activo === where.activo) ?? null,
      create: async () => { throw new Error("el CFDI no debe crear insumos"); },
      findUnique: async () => { throw new Error("el CFDI no debe tocar el catálogo"); },
    },
    hospMovimientoInsumo: { createMany: async () => { throw new Error("el CFDI no debe escribir kardex"); } },
    hospCfdiLinea: {
      findMany: async ({ where }: any) =>
        lineas.filter(
          (l) =>
            (!where.invoiceId || l.invoiceId === where.invoiceId) &&
            (!where.proveedorRfc || l.proveedorRfc === where.proveedorRfc) &&
            (!where.estado || l.estado === where.estado) &&
            (!where.id?.not || l.id !== where.id.not)
        ),
      findFirst: async ({ where }: any) => lineas.find((l) => l.id === where.id && l.companyId === where.companyId) ?? null,
      create: async ({ data }: any) => { lineas.push({ id: `l${seq++}`, ...data }); },
      update: async ({ where, data }: any) => Object.assign(lineas.find((l) => l.id === where.id)!, data),
      updateMany: async ({ where, data }: any) => {
        const ls = lineas.filter((l) => where.id.in.includes(l.id) && l.estado === where.estado);
        ls.forEach((l) => Object.assign(l, data));
        return { count: ls.length };
      },
    },
  };
  return db;
}

const COMPRA = {
  id: "i1", companyId: "c1", tipo: "EGRESO", tipoSat: "I", status: "STAMPED", contraparteRfc: null, customer: { rfc: "FAR010101AA1" },
  items: [
    { descripcion: "CEFALOTINA 1 G SOLUCION INYECTABLE", cantidad: 50, claveUnidad: "H87", claveProdServ: "51101500", valorUnitario: 18.5, importe: 925, descuento: 0 },
    { descripcion: "GUANTE DE LATEX ESTERIL MEDIANO", cantidad: 10, claveUnidad: "H87", claveProdServ: "42132203", valorUnitario: 5, importe: 50, descuento: 0 },
    { descripcion: "FLETE", cantidad: 1, claveUnidad: "E48", claveProdServ: "78101800", valorUnitario: 150, importe: 150, descuento: 0 },
  ],
  rawXml: null,
};
const ORDEN = {
  vinculos: [{ invoiceId: "i1", companyId: "c1", estado: "VINCULADA", targetTipo: "ADJUDICACION", targetId: "adj1" }],
  adjs: [{
    id: "adj1", cotizacionId: "cot1",
    solicitud: { partidas: [
      { id: "p1", hospInsumoId: "cef", descripcion: "Cefalotina 1 g sol. iny.", cantidad: 50, precioUnitario: 18, cotizacionGanadoraId: "cot1", hospInsumo: { nombre: "Cefalotina 1 g", clave: "MED001" } },
      // Ganó otra cotización (otro proveedor): no es de esta orden.
      { id: "p9", hospInsumoId: "gua", descripcion: "Guante de látex estéril mediano", cantidad: 10, precioUnitario: 5, cotizacionGanadoraId: "cot2", hospInsumo: { nombre: "Guante", clave: "MAT9" } },
    ] },
  }],
};

describe("ligarCfdiCompra", () => {
  it("CFDI de una orden: el renglón va a la línea de la orden; lo demás que es insumo a la cola; el flete no entra", async () => {
    const db = fakeDb({ invoices: [COMPRA], ...ORDEN });
    const r = await ligarCfdiCompra(db, { companyId: "c1", invoiceId: "i1" });
    expect(r).toEqual({ ligadas: 1, porLigar: 1 });
    expect(db._lineas.map((l: Row) => [l.descripcion, l.estado, l.origen, l.insumoId, l.solicitudPartidaId])).toEqual([
      ["CEFALOTINA 1 G SOLUCION INYECTABLE", "LIGADA", "REQUISICION", "cef", "p1"],
      ["GUANTE DE LATEX ESTERIL MEDIANO", "POR_LIGAR", null, null, null],
    ]);
    expect(db._lineas[0]).toMatchObject({ proveedorRfc: "FAR010101AA1", cantidad: 50, importe: 925 });
  });

  it("re-pasada idempotente; si se suelta la orden, lo automático vuelve a la cola", async () => {
    const db = fakeDb({ invoices: [COMPRA], ...ORDEN });
    await ligarCfdiCompra(db, { companyId: "c1", invoiceId: "i1" });
    await ligarCfdiCompra(db, { companyId: "c1", invoiceId: "i1" });
    expect(db._lineas).toHaveLength(2);
    ORDEN.vinculos[0].estado = "IGNORADA";
    try {
      await ligarCfdiCompra(db, { companyId: "c1", invoiceId: "i1" });
    } finally {
      ORDEN.vinculos[0].estado = "VINCULADA";
    }
    expect(db._lineas.map((l: Row) => l.estado)).toEqual(["POR_LIGAR", "POR_LIGAR"]);
  });

  it("sin orden, lo aprendido del proveedor liga solo", async () => {
    const db = fakeDb({ invoices: [COMPRA], aprendido: [{ proveedorRfc: "FAR010101AA1", claveProveedor: "D:GUANTE DE LATEX ESTERIL MEDIANO", insumoId: "gua" }] });
    expect(await ligarCfdiCompra(db, { companyId: "c1", invoiceId: "i1" })).toEqual({ ligadas: 1, porLigar: 1 });
    expect(db._lineas.find((l: Row) => l.insumoId === "gua")).toMatchObject({ origen: "APRENDIDO", estado: "LIGADA" });
  });

  it("nota de crédito, cancelado o ingreso: nada", async () => {
    for (const inv of [{ ...COMPRA, tipoSat: "E" }, { ...COMPRA, status: "CANCELLED" }, { ...COMPRA, tipo: "INGRESO" }]) {
      const db = fakeDb({ invoices: [inv] });
      expect(await ligarCfdiCompra(db, { companyId: "c1", invoiceId: "i1" })).toEqual({ ligadas: 0, porLigar: 0 });
    }
  });

  it("ligar a mano aprende la clave y liga los pendientes iguales del mismo proveedor; lo manual no se recalcula", async () => {
    const otra = { ...COMPRA, id: "i2" };
    const db = fakeDb({ invoices: [COMPRA, otra], insumos: [{ id: "gua", companyId: "c1", activo: true }] });
    await ligarCfdiCompra(db, { companyId: "c1", invoiceId: "i1" });
    await ligarCfdiCompra(db, { companyId: "c1", invoiceId: "i2" });
    const guante = db._lineas.find((l: Row) => l.invoiceId === "i1" && l.descripcion.startsWith("GUANTE"));
    const r = await ligarLineaManual(db, { companyId: "c1", lineaId: guante.id, insumoId: "gua", userId: "u1" });
    expect(r.propagadas).toBe(1);
    expect(db._aprendido).toEqual([{ companyId: "c1", proveedorRfc: "FAR010101AA1", claveProveedor: "D:GUANTE DE LATEX ESTERIL MEDIANO", insumoId: "gua", creadoPorId: "u1" }]);
    expect(db._lineas.filter((l: Row) => l.insumoId === "gua").map((l: Row) => [l.invoiceId, l.origen])).toEqual([["i1", "MANUAL"], ["i2", "APRENDIDO"]]);
    await ligarCfdiCompra(db, { companyId: "c1", invoiceId: "i1" });
    expect(guante).toMatchObject({ origen: "MANUAL", insumoId: "gua", ligadoPorId: "u1" });
  });
});

describe("derivarInsumosDesdeCfdi con «la recepción manda»", () => {
  it("la compra no crea insumos ni kardex: liga renglones; la venta no hace nada", async () => {
    const db = fakeDb({ invoices: [COMPRA], ...ORDEN });
    const args = { companyId: "c1", invoiceId: "i1", tipo: "EGRESO", tipoSat: "I", fecha: new Date(), items: COMPRA.items };
    expect(await derivarInsumosDesdeCfdi(db, args)).toEqual({ insumos: 0, movimientos: 0, ligadas: 1, porLigar: 1 });
    expect(await derivarInsumosDesdeCfdi(db, { ...args, tipo: "INGRESO" })).toEqual({ insumos: 0, movimientos: 0 });
  });
});
