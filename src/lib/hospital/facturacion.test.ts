import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  crear: vi.fn(),
  cargar: vi.fn(),
  descartar: vi.fn(),
  invoice: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { hospCargo: { findMany: m.findMany, updateMany: m.updateMany }, invoice: { findUnique: m.invoice } } }));
vi.mock("@/lib/facturas/prefacturas", () => ({ crearPrefactura: m.crear, cargarPrefactura: m.cargar, descartarPrefactura: m.descartar }));

import {
  CLAVE_GLOBAL,
  conceptosDeCargos,
  conceptosGlobales,
  dividirCargo,
  estadoFacturacion,
  prefacturaDesdeCargos,
  prefacturaSustituta,
  type CargoFacturable,
} from "./facturacion";

const cargo = (p: Partial<CargoFacturable> = {}): CargoFacturable => ({
  id: "c1",
  episodioId: "e1",
  fecha: new Date("2026-09-10T12:00:00Z"),
  categoria: "HABITACION",
  descripcion: "Habitación estándar",
  cantidad: 3,
  precioUnitario: 1000,
  importe: 3000,
  ivaTasa: 0.16,
  cancelado: false,
  invoiceId: null,
  prefacturaId: null,
  publicoGeneral: false,
  servicio: { claveProdServ: "85101501", claveUnidad: "E48" },
  ...p,
});

describe("estado de facturación de un cargo", () => {
  it("prioriza cancelado, facturado y honorario sobre lo demás", () => {
    expect(estadoFacturacion(cargo({ cancelado: true, invoiceId: "i" }))).toBe("CANCELADO");
    expect(estadoFacturacion(cargo({ invoiceId: "i", prefacturaId: "p", prefactura: { status: "TIMBRADA" }, invoice: { status: "STAMPED" } }))).toBe("FACTURADO");
    expect(estadoFacturacion(cargo({ categoria: "HONORARIO" }))).toBe("HONORARIO");
  });
  it("un CFDI cancelado suelta el cargo; una sustitución en curso lo muestra en prefactura", () => {
    expect(estadoFacturacion(cargo({ invoiceId: "i", invoice: { status: "CANCELLED" } }))).toBe("PENDIENTE");
    expect(estadoFacturacion(cargo({ invoiceId: "i", invoice: { status: "CANCELLED" }, publicoGeneral: true }))).toBe("PUBLICO_GENERAL");
    expect(estadoFacturacion(cargo({ invoiceId: "i", invoice: { status: "STAMPED" }, prefacturaId: "p2", prefactura: { status: "PENDIENTE" } }))).toBe("EN_PREFACTURA");
  });
  it("una prefactura descartada o timbrada no retiene el cargo", () => {
    expect(estadoFacturacion(cargo({ prefacturaId: "p", prefactura: { status: "PENDIENTE" } }))).toBe("EN_PREFACTURA");
    expect(estadoFacturacion(cargo({ prefacturaId: "p", prefactura: { status: "DESCARTADA" } }))).toBe("PENDIENTE");
    expect(estadoFacturacion(cargo({ publicoGeneral: true }))).toBe("PUBLICO_GENERAL");
  });
});

describe("conceptos del CFDI", () => {
  it("usa las claves del tarifario, o la del insumo con unidad pieza, y reporta los que no tienen", () => {
    const { items, sinClave } = conceptosDeCargos([
      cargo(),
      cargo({ id: "c2", servicio: null, lote: { insumo: { claveProdServ: "51101500" } }, cantidad: 2, precioUnitario: 50, importe: 100, ivaTasa: null }),
      cargo({ id: "c3", servicio: null, descripcion: "Material libre" }),
    ]);
    expect(items[0]).toMatchObject({ quantity: 3, product: { product_key: "85101501", unit_key: "E48", price: 1000, taxes: [{ rate: 0.16, factor: "Tasa" }] } });
    expect(items[1]).toMatchObject({ quantity: 2, product: { product_key: "51101500", unit_key: "H87", taxes: [{ rate: 0, factor: "Exento" }] } });
    expect(sinClave.map((c) => c.id)).toEqual(["c3"]);
  });
  it("un cargo dividido por importe va como 1 × importe", () => {
    const { items } = conceptosDeCargos([cargo({ cantidad: 1, precioUnitario: 900, importe: 900 }), cargo({ cantidad: 3, precioUnitario: 1000, importe: 2100 })]);
    expect(items[0]).toMatchObject({ quantity: 1, product: { price: 900 } });
    expect(items[1]).toMatchObject({ quantity: 1, product: { price: 2100 } });
  });
  it("la global agrupa por episodio y tasa, con 01010101 · ACT · Venta y el folio", () => {
    const items = conceptosGlobales([
      { ...cargo({ importe: 100 }), folio: "EP-1" },
      { ...cargo({ importe: 50 }), folio: "EP-1" },
      { ...cargo({ importe: 30, ivaTasa: 0 }), folio: "EP-1" },
      { ...cargo({ importe: 20 }), folio: "EP-2" },
    ]);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ quantity: 1, product: { description: "Venta", product_key: CLAVE_GLOBAL, unit_key: "ACT", sku: "EP-1", price: 150 } });
  });
});

describe("dividir un cargo", () => {
  const tx = (c: unknown) => ({
    hospCargo: {
      findUnique: vi.fn().mockResolvedValue(c),
      update: vi.fn().mockResolvedValue({ id: "c1" }),
      create: vi.fn().mockResolvedValue({ id: "c2" }),
    },
  });
  const base = { ...cargo(), companyId: "co", ivaContexto: null, origen: "ESTANCIA", servicioId: "s1", medicoId: null, movimientoInsumo: null };

  it("por cantidad conserva el precio y suma lo mismo", async () => {
    const t = tx(base);
    await dividirCargo(t as never, { companyId: "co", episodioId: "e1", cargoId: "c1", cantidad: 1 });
    expect(t.hospCargo.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { cantidad: 2, precioUnitario: 1000, importe: 2000 } });
    expect(t.hospCargo.create.mock.calls[0][0].data).toMatchObject({ cantidad: 1, precioUnitario: 1000, importe: 1000, servicioId: "s1", origen: "ESTANCIA" });
  });
  it("por importe deja dos cargos de 1 × importe", async () => {
    const t = tx(base);
    await dividirCargo(t as never, { companyId: "co", episodioId: "e1", cargoId: "c1", importe: 300 });
    expect(t.hospCargo.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { cantidad: 1, precioUnitario: 2700, importe: 2700 } });
    expect(t.hospCargo.create.mock.calls[0][0].data).toMatchObject({ cantidad: 1, precioUnitario: 300, importe: 300 });
  });
  it("no divide cargos amarrados a kardex, facturados ni fuera de rango", async () => {
    await expect(dividirCargo(tx({ ...base, movimientoInsumo: { id: "m" } }) as never, { companyId: "co", episodioId: "e1", cargoId: "c1", cantidad: 1 })).rejects.toMatchObject({ status: 409 });
    await expect(dividirCargo(tx({ ...base, invoiceId: "i" }) as never, { companyId: "co", episodioId: "e1", cargoId: "c1", cantidad: 1 })).rejects.toMatchObject({ status: 409 });
    await expect(dividirCargo(tx(base) as never, { companyId: "co", episodioId: "e1", cargoId: "c1", importe: 3000 })).rejects.toMatchObject({ status: 400 });
  });
});

describe("prefactura desde cargos", () => {
  const args = {
    companyId: "co", episodioId: "e1", customerId: "cu", cargoIds: ["c1"],
    datos: { formaPago: "03", metodoPago: "PUE" as const, usoCfdi: "D01" }, actor: { id: "u" }, req: new Request("https://x.test"),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    m.findMany.mockResolvedValue([cargo()]);
    m.crear.mockResolvedValue({ status: 201, body: { id: "pre1" } });
  });

  it("crea el borrador y toma los cargos", async () => {
    m.updateMany.mockResolvedValue({ count: 1 });
    const r = await prefacturaDesdeCargos(args);
    expect(r.status).toBe(201);
    const call = m.updateMany.mock.calls[0][0]
    expect(call.data).toEqual({ prefacturaId: "pre1", invoiceId: null });
    expect(JSON.stringify(call.where)).toContain('"CANCELLED"');
  });
  it("si otro usuario tomó un cargo en ese instante, descarta el borrador y contesta 409", async () => {
    m.updateMany.mockResolvedValue({ count: 0 });
    m.cargar.mockResolvedValue({ id: "pre1" });
    await expect(prefacturaDesdeCargos(args)).rejects.toMatchObject({ status: 409 });
    expect(m.descartar).toHaveBeenCalledOnce();
  });
  it("no crea nada si un cargo ya está facturado o no tiene clave SAT", async () => {
    m.findMany.mockResolvedValue([cargo({ invoiceId: "i" })]);
    await expect(prefacturaDesdeCargos(args)).rejects.toMatchObject({ status: 409 });
    m.findMany.mockResolvedValue([cargo({ servicio: null })]);
    await expect(prefacturaDesdeCargos(args)).rejects.toMatchObject({ status: 422 });
    expect(m.crear).not.toHaveBeenCalled();
  });
});

describe("sustitución (motivo 01)", () => {
  const args = { companyId: "co", invoiceId: "old", actor: { id: "u" }, req: new Request("https://x.test") };
  const vieja = { id: "old", companyId: "co", uuid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", status: "STAMPED", customerId: "cu", formaPago: "03", metodoPago: "PUE", usoCfdi: "D01", customer: { rfc: "PEJJ800101AB1" } };
  beforeEach(() => {
    vi.clearAllMocks();
    m.invoice.mockResolvedValue(vieja);
    m.findMany.mockResolvedValue([cargo({ invoiceId: "old", invoice: { status: "STAMPED" }, prefacturaId: "pv", prefactura: { status: "TIMBRADA" } })]);
    m.crear.mockResolvedValue({ status: 201, body: { id: "pre2" } });
    m.updateMany.mockResolvedValue({ count: 1 });
  });
  it("arma la prefactura con relación 04 y toma los cargos SIN soltar el CFDI viejo", async () => {
    await prefacturaSustituta(args);
    expect(m.crear.mock.calls[0][0]).toMatchObject({ customerId: "cu", formaPago: "03", relations: { relationship: "04", documents: [vieja.uuid] } });
    const call = m.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ invoiceId: "old" });
    expect(call.data).toEqual({ prefacturaId: "pre2" });
  });
  it("no sustituye una global, un CFDI no vigente ni una factura sin cargos", async () => {
    m.invoice.mockResolvedValue({ ...vieja, customer: { rfc: "XAXX010101000" } });
    await expect(prefacturaSustituta(args)).rejects.toMatchObject({ status: 409 });
    m.invoice.mockResolvedValue({ ...vieja, status: "CANCELLED" });
    await expect(prefacturaSustituta(args)).rejects.toMatchObject({ status: 409 });
    m.invoice.mockResolvedValue(vieja);
    m.findMany.mockResolvedValue([]);
    await expect(prefacturaSustituta(args)).rejects.toMatchObject({ status: 409 });
    expect(m.crear).not.toHaveBeenCalled();
  });
});
