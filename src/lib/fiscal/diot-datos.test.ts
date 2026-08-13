import { describe, expect, it } from "vitest";
import { agruparPorProveedor, tipoTerceroDeRfc, totalesDiot, type ProveedorDiotRow } from "./diot-datos";

/** Operación pagada del mes, con la forma que devuelve `operacionesEgresoFlujo`. */
type Op = Parameters<typeof agruparPorProveedor>[0][number];

const op = (over: Partial<Op>): Op =>
  ({
    rfc: "AAA010101AAA",
    razonSocial: "Proveedor SA",
    totalPagado: 0,
    base16Pagada: 0,
    ivaAcreditable: 0,
    base0Pagada: 0,
    exentosPagados: 0,
    ivaNoAcreditable: 0,
    ivaRetenido: 0,
    ...over,
  }) as Op;

describe("tipoTerceroDeRfc", () => {
  it("clasifica nacional, extranjero y global", () => {
    expect(tipoTerceroDeRfc("AAA010101AAA")).toBe("04"); // PM nacional
    expect(tipoTerceroDeRfc("AAAA010101AAA")).toBe("04"); // PF nacional
    expect(tipoTerceroDeRfc("XEXX010101000")).toBe("05"); // extranjero
    expect(tipoTerceroDeRfc("XAXX010101000")).toBe("15"); // público en general
  });

  it("un RFC corto se trata como extranjero, no como nacional", () => {
    // Un RFC de menos de 12 no puede ser mexicano bien formado.
    expect(tipoTerceroDeRfc("ABC")).toBe("05");
  });
});

describe("agruparPorProveedor", () => {
  it("suma varias operaciones del MISMO proveedor en un renglón", () => {
    const rows = agruparPorProveedor([
      op({ base16Pagada: 1000, ivaAcreditable: 160, totalPagado: 1160 }),
      op({ base16Pagada: 500, ivaAcreditable: 80, totalPagado: 580 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].operaciones).toBe(2);
    expect(rows[0].valorActosGravados16).toBe(1500);
    expect(rows[0].ivaTrasladadoPagado16).toBe(240);
    expect(rows[0].totalPagado).toBe(1740);
  });

  it("separa proveedores distintos", () => {
    const rows = agruparPorProveedor([
      op({ rfc: "AAA010101AAA", ivaAcreditable: 100 }),
      op({ rfc: "BBB020202BBB", razonSocial: "Otro", ivaAcreditable: 300 }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("ordena por IVA acreditable descendente (es el orden en que se revisa)", () => {
    const rows = agruparPorProveedor([
      op({ rfc: "AAA010101AAA", ivaAcreditable: 100 }),
      op({ rfc: "BBB020202BBB", ivaAcreditable: 900 }),
      op({ rfc: "CCC030303CCC", ivaAcreditable: 500 }),
    ]);
    expect(rows.map((r) => r.ivaTrasladadoPagado16)).toEqual([900, 500, 100]);
  });

  it("una operación sin RFC cae en el genérico de público en general", () => {
    const rows = agruparPorProveedor([op({ rfc: null, razonSocial: null, ivaAcreditable: 16 })]);
    expect(rows[0].rfc).toBe("XAXX010101000");
    expect(rows[0].razonSocial).toBe("PUBLICO EN GENERAL");
    expect(rows[0].tipoTercero).toBe("15");
  });

  it("el IVA no acreditable se reporta aparte, no dentro del acreditable", () => {
    // Un proveedor 69-B: la operación SÍ se informa, pero su IVA no acredita.
    const rows = agruparPorProveedor([
      op({ base16Pagada: 1000, ivaAcreditable: 0, ivaNoAcreditable: 160, totalPagado: 1160 }),
    ]);
    expect(rows[0].ivaTrasladadoPagado16).toBe(0);
    expect(rows[0].ivaNoAcreditable).toBe(160);
  });

  it("sin operaciones devuelve lista vacía", () => {
    expect(agruparPorProveedor([])).toEqual([]);
  });
});

describe("totalesDiot", () => {
  const fila = (over: Partial<ProveedorDiotRow>): ProveedorDiotRow => ({
    rfc: "AAA010101AAA", razonSocial: "P", tipoTercero: "04", operaciones: 1,
    valorActosGravados16: 0, ivaTrasladadoPagado16: 0, valorActosGravados0: 0,
    valorActosExentos: 0, ivaNoAcreditable: 0, ivaRetenido: 0, totalPagado: 0, ...over,
  });

  it("suma todas las columnas y cuenta proveedores", () => {
    const t = totalesDiot([
      fila({ valorActosGravados16: 1000, ivaTrasladadoPagado16: 160, ivaRetenido: 20 }),
      fila({ rfc: "BBB020202BBB", valorActosGravados16: 500, ivaTrasladadoPagado16: 80 }),
    ]);
    expect(t.proveedores).toBe(2);
    expect(t.operaciones).toBe(2);
    expect(t.valorActosGravados16).toBe(1500);
    expect(t.ivaTrasladadoPagado16).toBe(240);
    expect(t.ivaRetenido).toBe(20);
  });

  it("sin proveedores todo queda en cero (no NaN)", () => {
    const t = totalesDiot([]);
    expect(t.proveedores).toBe(0);
    expect(t.ivaTrasladadoPagado16).toBe(0);
    expect(Number.isNaN(t.totalPagado)).toBe(false);
  });
});
