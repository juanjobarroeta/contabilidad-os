import { describe, it, expect } from "vitest";
import {
  clasificarInsumo,
  claveDeInsumo,
  derivarInsumosBackfill,
  derivarInsumosDesdeCfdi,
  etiquetarControlados,
  extraerConceptosCfdi,
  ivaTasaDeCategoria,
  normalizarDescripcion,
  unidadDesdeClaveUnidad,
} from "./insumos-cfdi";

// ─── Clasificación ───────────────────────────────────────────────────────────

describe("clasificarInsumo()", () => {
  const casos: Array<[string, string, string | null]> = [
    // clave 51: medicamentos; la solución parenteral es categoría propia
    ["51101500", "AMOXICILINA 500 MG CAPSULA C/12", "MEDICAMENTO"],
    ["51191600", "SOLUCION HARTMANN 1000 ML", "SOLUCION"],
    ["51191600", "SOL. GLUCOSADA 5% 500ML BOLSA", "SOLUCION"],
    ["51101700", "KETOROLACO 30 MG SOL. INY. 1 ML", "MEDICAMENTO"],
    // clave 42: material por default, equipo cuando lo dice, bolsa de solución
    ["42311500", "GASA ESTERIL 10X10 PAQ 200", "MATERIAL_CURACION"],
    ["42181500", "MONITOR DE SIGNOS VITALES 5 PARAMETROS", "EQUIPO"],
    ["42191800", "CAMA HOSPITALARIA ELECTRICA 3 POSICIONES", "EQUIPO"],
    ["42221500", "EQUIPO DE VENOCLISIS NORMOGOTERO", "MATERIAL_CURACION"],
    ["42181700", "ELECTRODOS PARA MONITOR ADULTO C/50", "MATERIAL_CURACION"],
    ["42221600", "SOLUCION CLORURO DE SODIO 0.9% 500 ML", "SOLUCION"],
    ["42132200", "CUBREBOCAS TRIPLE CAPA C/50", "MATERIAL_CURACION"],
    // clave 41: laboratorio
    ["41116100", "REACTIVO GLUCOSA 4X100 ML", "REACTIVO"],
    ["41103300", "CENTRIFUGA DE LABORATORIO 24 TUBOS", "EQUIPO"],
    // servicios y exclusiones: nunca
    ["85121600", "HONORARIOS MEDICOS CIRUGIA", null],
    ["78101800", "FLETE LOCAL", null],
    ["80131500", "RENTA DE OFICINA", null],
    ["83101800", "ENERGIA ELECTRICA", null],
    ["01010101", "RENTA DE CONCENTRADOR DE OXIGENO", null],
    ["42271700", "RENTA DE VENTILADOR MECANICO", null],
    // clave genérica o ajena: decide la descripción
    ["01010101", "KETOROLACO 30 MG AMPOLLETA", "MEDICAMENTO"],
    ["01010101", "JERINGA 5 ML C/AGUJA 21G", "MATERIAL_CURACION"],
    ["46181504", "GUANTES DE LATEX MEDIANO C/100", "MATERIAL_CURACION"],
    ["12191601", "ALCOHOL ETILICO 70% 1000 ML", "MATERIAL_CURACION"],
    ["01010101", "TIRAS REACTIVAS GLUCOSA C/50", "REACTIVO"],
    ["01010101", "PAPELERIA VARIA", null],
    ["43211900", "MONITOR LED 24 PULGADAS", null],
    ["01010101", "", null],
  ];
  for (const [clave, desc, esperado] of casos) {
    it(`${clave} «${desc}» → ${esperado ?? "no es insumo"}`, () => {
      const r = clasificarInsumo({ claveProdServ: clave, descripcion: desc });
      expect(r.esInsumo).toBe(esperado != null);
      if (esperado) expect(r.categoria).toBe(esperado);
    });
  }

  it("tolera clave nula y descripción nula", () => {
    expect(clasificarInsumo({ claveProdServ: null, descripcion: null }).esInsumo).toBe(false);
    expect(clasificarInsumo({ claveProdServ: null, descripcion: "PARACETAMOL 500 MG TABLETA" }).categoria).toBe("MEDICAMENTO");
  });

  it("IVA con el que nace el insumo: medicinas y soluciones a 0 %, lo demás 16 %", () => {
    expect(ivaTasaDeCategoria("MEDICAMENTO")).toBe(0);
    expect(ivaTasaDeCategoria("SOLUCION")).toBe(0);
    expect(ivaTasaDeCategoria("MATERIAL_CURACION")).toBe(0.16);
    expect(ivaTasaDeCategoria("EQUIPO")).toBe(0.16);
  });
});

// ─── Clave estable ───────────────────────────────────────────────────────────

describe("claveDeInsumo()", () => {
  it("usa el NoIdentificacion cuando lo hay (trim, mayúsculas, ≤ 40)", () => {
    expect(claveDeInsumo(" abc-123 ", "lo que sea")).toBe("ABC-123");
    expect(claveDeInsumo("X".repeat(50), "d")).toHaveLength(40);
  });
  it("ignora identificadores de ruido y cae a la descripción normalizada", () => {
    expect(claveDeInsumo("N/A", "Solución Hartmann 1000 ml")).toBe("SOLUCION HARTMANN 1000 ML");
    expect(claveDeInsumo("01010101", "GASA")).toBe("GASA");
    expect(claveDeInsumo("-", "GASA")).toBe("GASA");
    expect(claveDeInsumo(null, "Ketorolaco 30mg (sol. iny.)")).toBe("KETOROLACO 30MG SOL INY");
  });
  it("normaliza acentos, puntuación y espacios; topa a 60", () => {
    expect(normalizarDescripcion("  Cefalotina 1 g   sol. iny. — ámpula ")).toBe("CEFALOTINA 1 G SOL INY AMPULA");
    const larga = claveDeInsumo(null, "A".repeat(30) + " " + "B".repeat(50));
    expect(larga!.length).toBeLessThanOrEqual(60);
  });
  it("sin nada útil devuelve null", () => {
    expect(claveDeInsumo(null, "")).toBeNull();
    expect(claveDeInsumo("N/A", "   ")).toBeNull();
  });
});

describe("unidadDesdeClaveUnidad()", () => {
  it("mapea las claves del SAT y cae a pieza", () => {
    expect(unidadDesdeClaveUnidad("H87")).toBe("pieza");
    expect(unidadDesdeClaveUnidad("xbx")).toBe("caja");
    expect(unidadDesdeClaveUnidad("LTR")).toBe("litro");
    expect(unidadDesdeClaveUnidad("ZZZ")).toBe("pieza");
    expect(unidadDesdeClaveUnidad(null)).toBe("pieza");
  });
});

describe("extraerConceptosCfdi()", () => {
  it("lee NoIdentificacion, clave, unidad, cantidad e importe de cada concepto", () => {
    const xml = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I">
      <cfdi:Conceptos>
        <cfdi:Concepto ClaveProdServ="51101700" NoIdentificacion="MED-001" ClaveUnidad="H87" Cantidad="10" ValorUnitario="12.50" Importe="125.00" Descripcion="KETOROLACO 30 MG AMPOLLETA"/>
        <cfdi:Concepto ClaveProdServ="42311500" ClaveUnidad="XBX" Cantidad="2" ValorUnitario="200" Importe="400" Descripcion="GASA ESTERIL 10X10">
          <cfdi:Impuestos/>
        </cfdi:Concepto>
      </cfdi:Conceptos>
    </cfdi:Comprobante>`;
    const c = extraerConceptosCfdi(xml);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ noIdentificacion: "MED-001", claveProdServ: "51101700", claveUnidad: "H87", cantidad: 10, valorUnitario: 12.5, importe: 125 });
    expect(c[1]).toMatchObject({ noIdentificacion: null, claveUnidad: "XBX", cantidad: 2 });
  });
});

// ─── Derivación con un Prisma falso ──────────────────────────────────────────

type Row = Record<string, any>;

function fakeDb() {
  const insumos: Row[] = [];
  const movs: Row[] = [];
  const progreso: Row[] = [];
  const invoices: Row[] = [];
  let seq = 1;

  const conMovimientos = (i: Row, select: any) => {
    const out: Row = { id: i.id };
    if (select?.clave) out.clave = i.clave;
    if (select?.nombre) out.nombre = i.nombre;
    if (select?.ultimoCosto) out.ultimoCosto = i.ultimoCosto;
    if (select?.movimientos) {
      const tipo = select.movimientos.where?.tipo;
      out.movimientos = movs
        .filter((m) => m.insumoId === i.id && (!tipo || m.tipo === tipo))
        .sort((a, b) => +b.fecha - +a.fecha)
        .slice(0, select.movimientos.take ?? undefined)
        .map((m) => ({ fecha: m.fecha }));
    }
    return out;
  };

  return {
    _insumos: insumos,
    _movs: movs,
    _progreso: progreso,
    _invoices: invoices,
    hospInsumo: {
      findUnique: async ({ where, select }: any) => {
        const k = where.companyId_clave;
        const i = insumos.find((x) => x.companyId === k.companyId && x.clave === k.clave);
        return i ? conMovimientos(i, select) : null;
      },
      findMany: async ({ where, select }: any) => {
        if (!where.OR) {
          // Filtro plano por igualdad (etiquetarControlados): companyId, derivadoDeCfdi, grupoControl null…
          return insumos
            .filter((x) => Object.entries(where).every(([k, v]) => (x[k] ?? null) === v))
            .map((i) => conMovimientos(i, select));
        }
        const claves: string[] = where.OR?.find((o: any) => o.clave)?.clave.in ?? [];
        const nombres: string[] = (where.OR?.find((o: any) => o.nombre)?.nombre.in ?? []).map((n: string) => n.toLowerCase());
        return insumos
          .filter((x) => x.companyId === where.companyId && (claves.includes(x.clave) || nombres.includes(String(x.nombre).toLowerCase())))
          .map((i) => conMovimientos(i, select));
      },
      create: async ({ data }: any) => {
        if (insumos.some((x) => x.companyId === data.companyId && x.clave === data.clave)) {
          throw new Error("unique");
        }
        const row = { id: `ins_${seq++}`, ...data };
        insumos.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: any) => {
        const i = insumos.find((x) => x.id === where.id)!;
        Object.assign(i, data);
        return i;
      },
      count: async () => insumos.length,
    },
    hospMovimientoInsumo: {
      createMany: async ({ data }: any) => {
        let count = 0;
        for (const d of data) {
          const dup = movs.some((m) => m.insumoId === d.insumoId && m.invoiceId === d.invoiceId && m.tipo === d.tipo);
          if (dup) continue;
          movs.push({ id: `mov_${seq++}`, ...d });
          count++;
        }
        return { count };
      },
      count: async () => movs.length,
    },
    backfillProgreso: {
      findUnique: async ({ where }: any) =>
        progreso.find((p) => p.companyId === where.companyId_job.companyId && p.job === where.companyId_job.job) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const p = progreso.find((x) => x.companyId === where.companyId_job.companyId && x.job === where.companyId_job.job);
        if (!p) {
          progreso.push({ ...create, updatedAt: new Date() });
          return;
        }
        p.cursor = update.cursor;
        p.completadoAt = update.completadoAt;
        p.procesados += update.procesados.increment;
        p.derivados += update.derivados.increment;
        p.updatedAt = new Date();
      },
    },
    invoice: {
      findMany: async ({ where, take, select }: any) => {
        let rows = invoices.filter((i) => i.companyId === where.companyId);
        if (where.id?.gt) rows = rows.filter((i) => i.id > where.id.gt);
        if (where.id?.in) rows = rows.filter((i) => where.id.in.includes(i.id));
        rows = rows.sort((a, b) => (a.id < b.id ? -1 : 1));
        if (take) rows = rows.slice(0, take);
        if (select?.rawXml) return rows.map((r) => ({ id: r.id, rawXml: r.rawXml ?? null }));
        return rows.map((r) => ({ id: r.id, tipo: r.tipo, tipoSat: r.tipoSat ?? null, fecha: r.fecha, items: r.items }));
      },
    },
  };
}

const base = { companyId: "c1", tipoSat: "I" as string | null };
const compra = (invoiceId: string, fecha: string) => ({
  ...base,
  invoiceId,
  tipo: "EGRESO",
  fecha: new Date(fecha),
  items: [
    { descripcion: "KETOROLACO 30 MG AMPOLLETA", cantidad: 10, claveUnidad: "H87", claveProdServ: "51101700", valorUnitario: 12.5, importe: 125 },
    { descripcion: "KETOROLACO 30 MG AMPOLLETA", cantidad: 10, claveUnidad: "H87", claveProdServ: "51101700", valorUnitario: 14.5, importe: 145 },
    { descripcion: "GASA ESTERIL 10X10", cantidad: 100, claveUnidad: "XBX", claveProdServ: "42311500", valorUnitario: 2, importe: 200 },
    { descripcion: "HONORARIOS MEDICOS", cantidad: 1, claveUnidad: "E48", claveProdServ: "85121600", valorUnitario: 5000, importe: 5000 },
  ],
});

describe("derivarInsumosDesdeCfdi()", () => {
  it("compra: da de alta el insumo y UNA entrada por (insumo, CFDI) con líneas agregadas", async () => {
    const db = fakeDb();
    const r = await derivarInsumosDesdeCfdi(db as never, compra("inv-1", "2026-03-01"));
    expect(r).toEqual({ insumos: 2, movimientos: 2 });

    const keto = db._insumos.find((i) => i.clave === "KETOROLACO 30 MG AMPOLLETA")!;
    expect(keto).toMatchObject({ categoria: "MEDICAMENTO", unidad: "pieza", ivaTasa: 0, derivadoDeCfdi: true, ultimoCosto: 13.5 });
    const gasa = db._insumos.find((i) => i.clave === "GASA ESTERIL 10X10")!;
    expect(gasa).toMatchObject({ categoria: "MATERIAL_CURACION", unidad: "caja", ivaTasa: 0.16 });

    const mov = db._movs.find((m) => m.insumoId === keto.id)!;
    expect(mov).toMatchObject({ tipo: "ENTRADA_COMPRA", cantidad: 20, costoUnitario: 13.5, invoiceId: "inv-1", loteId: null });
    // Los honorarios no entran al almacén.
    expect(db._insumos.some((i) => i.clave.includes("HONORARIOS"))).toBe(false);
  });

  it("es idempotente: el mismo CFDI dos veces no duplica nada", async () => {
    const db = fakeDb();
    await derivarInsumosDesdeCfdi(db as never, compra("inv-1", "2026-03-01"));
    const r = await derivarInsumosDesdeCfdi(db as never, compra("inv-1", "2026-03-01"));
    expect(r).toEqual({ insumos: 0, movimientos: 0 });
    expect(db._insumos).toHaveLength(2);
    expect(db._movs).toHaveLength(2);
  });

  it("nota de crédito y tipos ajenos no mueven kardex", async () => {
    const db = fakeDb();
    expect(await derivarInsumosDesdeCfdi(db as never, { ...compra("nc-1", "2026-03-02"), tipoSat: "E" })).toEqual({ insumos: 0, movimientos: 0 });
    expect(await derivarInsumosDesdeCfdi(db as never, { ...compra("p-1", "2026-03-02"), tipo: "PAGO" })).toEqual({ insumos: 0, movimientos: 0 });
    expect(db._movs).toHaveLength(0);
  });

  it("último costo: manda la compra más reciente por FECHA, no la última procesada", async () => {
    const db = fakeDb();
    await derivarInsumosDesdeCfdi(db as never, compra("inv-2", "2026-06-01"));
    const vieja = compra("inv-1", "2025-01-15");
    vieja.items[0].valorUnitario = 9;
    vieja.items[1].valorUnitario = 9;
    await derivarInsumosDesdeCfdi(db as never, vieja);
    const keto = db._insumos.find((i) => i.clave === "KETOROLACO 30 MG AMPOLLETA")!;
    expect(keto.ultimoCosto).toBe(13.5);
    expect(db._movs.filter((m) => m.insumoId === keto.id)).toHaveLength(2);
  });

  it("venta: SALIDA_VENTA sólo para claves que ya existen; nunca crea insumos", async () => {
    const db = fakeDb();
    await derivarInsumosDesdeCfdi(db as never, compra("inv-1", "2026-03-01"));
    const r = await derivarInsumosDesdeCfdi(db as never, {
      ...base,
      invoiceId: "venta-1",
      tipo: "INGRESO",
      fecha: new Date("2026-03-10"),
      items: [
        { descripcion: "Ketorolaco 30 mg ampolleta", cantidad: 5, claveUnidad: "H87", claveProdServ: "51101700", valorUnitario: 40, importe: 200 },
        { descripcion: "HABITACION ESTANDAR", cantidad: 2, claveUnidad: "E48", claveProdServ: "85101500", valorUnitario: 3200, importe: 6400 },
        { descripcion: "PARACETAMOL 500 MG TABLETA", cantidad: 4, claveUnidad: "H87", claveProdServ: "51101500", valorUnitario: 8, importe: 32 },
      ],
    });
    expect(r).toEqual({ insumos: 0, movimientos: 1 });
    expect(db._insumos).toHaveLength(2);
    const keto = db._insumos.find((i) => i.clave === "KETOROLACO 30 MG AMPOLLETA")!;
    const salida = db._movs.find((m) => m.tipo === "SALIDA_VENTA")!;
    expect(salida).toMatchObject({ insumoId: keto.id, cantidad: -5, costoUnitario: 13.5, invoiceId: "venta-1" });
    expect(keto.precioVenta).toBe(40);
  });

  it("con rawXml la llave es el NoIdentificacion del concepto (empate por descripción+cantidad+importe)", async () => {
    const db = fakeDb();
    const rawXml = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I"><cfdi:Conceptos>
      <cfdi:Concepto ClaveProdServ="51101700" NoIdentificacion="MED-001" ClaveUnidad="H87" Cantidad="10" ValorUnitario="12.50" Importe="125.00" Descripcion="KETOROLACO 30 MG AMPOLLETA"/>
      <cfdi:Concepto ClaveProdServ="42311500" ClaveUnidad="XBX" Cantidad="100" ValorUnitario="2" Importe="200" Descripcion="GASA ESTERIL 10X10"/>
    </cfdi:Conceptos></cfdi:Comprobante>`;
    const r = await derivarInsumosDesdeCfdi(db as never, {
      ...base,
      invoiceId: "inv-x",
      tipo: "EGRESO",
      fecha: new Date("2026-03-01"),
      rawXml,
      items: [
        { descripcion: "KETOROLACO 30 MG AMPOLLETA", cantidad: 10, claveUnidad: "H87", claveProdServ: "51101700", valorUnitario: 12.5, importe: 125 },
        { descripcion: "GASA ESTERIL 10X10", cantidad: 100, claveUnidad: "XBX", claveProdServ: "42311500", valorUnitario: 2, importe: 200 },
      ],
    });
    expect(r).toEqual({ insumos: 2, movimientos: 2 });
    expect(db._insumos.map((i) => i.clave).sort()).toEqual(["GASA ESTERIL 10X10", "MED-001"]);
    // La venta del hospital sin código empata por descripción con el insumo de código.
    const v = await derivarInsumosDesdeCfdi(db as never, {
      ...base,
      invoiceId: "venta-x",
      tipo: "INGRESO",
      fecha: new Date("2026-03-05"),
      items: [{ descripcion: "GASA ESTERIL 10X10", cantidad: 3, claveUnidad: "XBX", claveProdServ: "42311500", valorUnitario: 5, importe: 15 }],
    });
    expect(v.movimientos).toBe(1);
    // …y la venta sin código del insumo que SÍ tiene código empata por NOMBRE.
    const v2 = await derivarInsumosDesdeCfdi(db as never, {
      ...base,
      invoiceId: "venta-y",
      tipo: "INGRESO",
      fecha: new Date("2026-03-06"),
      items: [{ descripcion: "Ketorolaco 30 mg ampolleta", cantidad: 2, claveUnidad: "H87", claveProdServ: "51101700", valorUnitario: 40, importe: 80 }],
    });
    expect(v2.movimientos).toBe(1);
    const med = db._insumos.find((i) => i.clave === "MED-001")!;
    expect(db._movs.find((m) => m.invoiceId === "venta-y")).toMatchObject({ insumoId: med.id, cantidad: -2 });
    expect(db._insumos).toHaveLength(2);
  });

  it("sin items guardados, los conceptos del XML son las líneas", async () => {
    const db = fakeDb();
    const rawXml = `<cfdi:Comprobante TipoDeComprobante="I"><cfdi:Conceptos>
      <cfdi:Concepto ClaveProdServ="42311500" NoIdentificacion="GAS-10" ClaveUnidad="XBX" Cantidad="4" ValorUnitario="2" Importe="8" Descripcion="GASA ESTERIL 10X10"/>
    </cfdi:Conceptos></cfdi:Comprobante>`;
    const r = await derivarInsumosDesdeCfdi(db as never, { ...base, invoiceId: "i", tipo: "EGRESO", fecha: new Date(), rawXml, items: [] });
    expect(r).toEqual({ insumos: 1, movimientos: 1 });
    expect(db._insumos[0].clave).toBe("GAS-10");
  });
});

describe("derivarInsumosBackfill()", () => {
  it("barre por cursor, guarda el progreso y en la siguiente corrida sólo ve lo nuevo", async () => {
    const db = fakeDb();
    db._invoices.push(
      { id: "a1", companyId: "c1", tipo: "EGRESO", fecha: new Date("2026-01-10"), items: compra("a1", "2026-01-10").items },
      { id: "a2", companyId: "c1", tipo: "INGRESO", fecha: new Date("2026-01-12"), items: [{ descripcion: "KETOROLACO 30 MG AMPOLLETA", cantidad: 2, claveUnidad: "H87", claveProdServ: "51101700", valorUnitario: 40, importe: 80 }] },
      { id: "a3", companyId: "c1", tipo: "EGRESO", fecha: new Date("2026-01-15"), items: [{ descripcion: "RENTA DE OFICINA", cantidad: 1, claveUnidad: "E48", claveProdServ: "80131500", valorUnitario: 10000, importe: 10000 }] }
    );
    const r1 = await derivarInsumosBackfill(db as never, "c1", { page: 2, budgetMs: 10_000 });
    expect(r1).toMatchObject({ procesados: 3, insumos: 2, movimientos: 3, completado: true, nextAfterId: null });
    expect(db._progreso[0]).toMatchObject({ job: "hospital-insumos", cursor: "a3", procesados: 3, derivados: 3 });
    expect(db._progreso[0].completadoAt).toBeInstanceOf(Date);

    db._invoices.push({ id: "a4", companyId: "c1", tipo: "EGRESO", fecha: new Date("2026-02-01"), items: compra("a4", "2026-02-01").items });
    const r2 = await derivarInsumosBackfill(db as never, "c1", { page: 2, budgetMs: 10_000 });
    expect(r2).toMatchObject({ procesados: 1, insumos: 0, movimientos: 2, completado: true });
    expect(db._progreso[0]).toMatchObject({ cursor: "a4", procesados: 4, derivados: 5 });
  });

  it("con presupuesto agotado devuelve el cursor para continuar", async () => {
    const db = fakeDb();
    db._invoices.push({ id: "b1", companyId: "c1", tipo: "EGRESO", fecha: new Date(), items: compra("b1", "2026-01-10").items });
    const r = await derivarInsumosBackfill(db as never, "c1", { page: 1, budgetMs: 0 });
    expect(r).toMatchObject({ procesados: 0, completado: false, nextAfterId: null });
    expect(db._progreso[0].completadoAt).toBeNull();
  });
});

// ─── Controlados (LGS 234/245) ───────────────────────────────────────────────

describe("controlados al derivar", () => {
  const compraControlados = (invoiceId: string, fecha: string) => ({
    ...base,
    invoiceId,
    tipo: "EGRESO",
    fecha: new Date(fecha),
    items: [
      { descripcion: "MIDAZOLAM 5 MG/5 ML SOL. INY. AMPOLLETA", cantidad: 10, claveUnidad: "H87", claveProdServ: "51101500", valorUnitario: 40, importe: 400 },
      { descripcion: "FENTANILO CITRATO 0.5 MG/10 ML", cantidad: 5, claveUnidad: "H87", claveProdServ: "51101500", valorUnitario: 90, importe: 450 },
      { descripcion: "KETOROLACO 30 MG AMPOLLETA", cantidad: 10, claveUnidad: "H87", claveProdServ: "51101700", valorUnitario: 12.5, importe: 125 },
    ],
  });

  it("el insumo nuevo nace con grupo, sustancia activa y la bandera de controlado", async () => {
    const db = fakeDb();
    await derivarInsumosDesdeCfdi(db as never, compraControlados("inv-c1", "2026-03-01"));
    const mida = db._insumos.find((i) => i.nombre.startsWith("MIDAZOLAM"))!;
    const fenta = db._insumos.find((i) => i.nombre.startsWith("FENTANILO"))!;
    const keto = db._insumos.find((i) => i.nombre.startsWith("KETOROLACO"))!;
    expect(mida).toMatchObject({ grupoControl: "III", sustanciaActiva: "Midazolam", controlado: true });
    expect(fenta).toMatchObject({ grupoControl: "I", sustanciaActiva: "Fentanilo", controlado: true });
    expect(keto).toMatchObject({ grupoControl: null, sustanciaActiva: null, controlado: false });
  });

  it("una compra posterior no pisa el grupo que corrigió el responsable sanitario", async () => {
    const db = fakeDb();
    await derivarInsumosDesdeCfdi(db as never, compraControlados("inv-c1", "2026-03-01"));
    const mida = db._insumos.find((i) => i.nombre.startsWith("MIDAZOLAM"))!;
    mida.grupoControl = "II";
    mida.sustanciaActiva = "Midazolam (revisado)";
    const r = await derivarInsumosDesdeCfdi(db as never, compraControlados("inv-c2", "2026-04-01"));
    expect(r).toEqual({ insumos: 0, movimientos: 3 });
    expect(mida).toMatchObject({ grupoControl: "II", sustanciaActiva: "Midazolam (revisado)" });
  });

  it("etiquetarControlados sólo toca los derivados sin grupo ni sustancia", async () => {
    const db = fakeDb();
    const fila = (id: string, nombre: string, extra: Row) => ({ id, companyId: "c1", clave: id, nombre, controlado: false, grupoControl: null, sustanciaActiva: null, ...extra });
    db._insumos.push(
      fila("i1", "DIAZEPAM 10 MG TABLETA", { derivadoDeCfdi: true }),
      fila("i2", "MORFINA 10 MG/ML", { derivadoDeCfdi: false }), // capturado a mano: no se toca
      fila("i3", "MIDAZOLAM 5 MG", { derivadoDeCfdi: true, sustanciaActiva: "Midazolam" }), // ya revisado: no se toca
      fila("i4", "PROPOFOL 200 MG", { derivadoDeCfdi: true }) // no es controlado
    );
    const r = await etiquetarControlados(db as never, "c1");
    expect(r).toEqual({ revisados: 2, etiquetados: 1 });
    expect(db._insumos[0]).toMatchObject({ grupoControl: "III", sustanciaActiva: "Diazepam", controlado: true });
    expect(db._insumos[1]).toMatchObject({ grupoControl: null, controlado: false });
    expect(db._insumos[2]).toMatchObject({ grupoControl: null, sustanciaActiva: "Midazolam" });
    expect(db._insumos[3]).toMatchObject({ grupoControl: null, controlado: false });
  });
});
