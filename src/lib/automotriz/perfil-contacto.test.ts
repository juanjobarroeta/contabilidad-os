import { describe, it, expect } from "vitest";
import { perfilContacto } from "./perfil-contacto";

// Fake Prisma mínimo: un contacto que es a la vez cliente (le vendimos una
// unidad, PPD cobrada a medias con REP parcial) y proveedor (nos facturó PPD,
// le pagamos todo y NO nos ha emitido el REP — riesgo de deducción).
function fakeDb() {
  const contacto = {
    id: "cust1", companyId: "c1", rfc: "AAA010101AAA",
    razonSocial: "GRUPO DEMO", email: null, phone: null,
  };
  const facturas = [
    { // INGRESO (le facturamos la unidad): total 629,000; cobrado 300,000; REP por 200,000
      id: "f-venta", companyId: "c1", customerId: "cust1", tipo: "INGRESO", status: "STAMPED",
      uuid: "F5BF65B3-86C0-11F1-9687-578EFC729F41", serie: "NVS", folio: "2257",
      fecha: new Date("2026-07-23"), total: 629000, metodoPago: "PPD",
      conciliacionDetalles: [{ montoAsignado: 300000 }],
    },
    { // EGRESO (nos facturó): total 530,917.18; pagado completo; sin REP recibido
      id: "f-compra", companyId: "c1", customerId: "cust1", tipo: "EGRESO", status: "STAMPED",
      uuid: "8BFA8033-0833-11F1-B0A5-D1046CE86093", serie: "JC", folio: "119267",
      fecha: new Date("2026-02-12"), total: 530917.18, metodoPago: "PPD",
      conciliacionDetalles: [{ montoAsignado: -530917.18 }],
    },
  ];
  const reps = [
    { parentUuid: "f5bf65b3-86c0-11f1-9687-578efc729f41", impPagado: 200000 }, // minúsculas a propósito
  ];
  const vehiculos = [
    { id: "v1", companyId: "c1", clienteId: "cust1", supplierRfc: null, compraCustomerId: null,
      vin: "3GALD255XTM007338", marca: "JAC", modelo: "FRISON T9", anio: 2026, estado: "VENDIDO",
      fechaCompra: new Date("2026-02-12"), fechaVenta: new Date("2026-07-23"),
      costoCompra: 445700.05, precioVenta: 542241.38,
      comisionMonto: 5000, costos: [{ monto: 12000 }] },
  ];
  return {
    customer: { findUnique: async ({ where }: any) => (where.id === contacto.id ? contacto : null) },
    invoice: {
      findMany: async ({ where }: any) =>
        facturas.filter((f) => f.tipo === where.tipo && f.customerId === where.customerId),
    },
    pagoDoctoRelacionado: {
      findMany: async ({ where }: any) =>
        reps.filter((r) => where.parentUuid.in.includes(r.parentUuid)),
    },
    vehiculo: {
      findMany: async ({ where }: any) =>
        vehiculos.filter((v) =>
          where.clienteId ? v.clienteId === where.clienteId : true
        ),
    },
    // Taller y kardex del contacto (perfil 360°): sin movimientos en este fake.
    servicioVenta: { findMany: async () => [] },
    refaccionMovimiento: { findMany: async () => [] },
  };
}

describe("perfilContacto() — lado CLIENTE", () => {
  it("calcula cobrado, REP amparado (match case-insensitive) y saldo", async () => {
    const p = await perfilContacto(fakeDb() as never, "c1", "cust1", "CLIENTE");
    expect(p).not.toBeNull();
    expect(p!.resumen).toMatchObject({
      numFacturas: 1,
      totalFacturado: 629000,
      totalPagado: 300000,
      saldo: 329000,
      repPendienteMonto: 100000, // cobrado 300k − amparado 200k
      repPendienteFacturas: 1,
    });
    expect(p!.facturas[0]).toMatchObject({ amparadoRep: 200000, repPendiente: 100000 });
    expect(p!.unidades).toHaveLength(1);
    expect(p!.unidades[0].vin).toBe("3GALD255XTM007338");
  });
});

describe("perfilContacto() — lado PROVEEDOR", () => {
  it("detecta pagos PPD sin REP recibido (riesgo de deducción)", async () => {
    const p = await perfilContacto(fakeDb() as never, "c1", "cust1", "PROVEEDOR");
    expect(p!.resumen).toMatchObject({
      numFacturas: 1,
      totalFacturado: 530917.18,
      totalPagado: 530917.18, // montoAsignado en valor absoluto
      saldo: 0,
      repPendienteMonto: 530917.18, // pagado íntegro y sin complemento del proveedor
      repPendienteFacturas: 1,
    });
  });
});

describe("perfilContacto() — evidencia de pago sin conciliación bancaria", () => {
  // Empresa sin bancos cargados (onboarding recién hecho): PUE cuenta como
  // cobrada por definición y PPD por los REPs que la amparan.
  function fakeDbSinBancos() {
    const contacto = {
      id: "cust1", companyId: "c1", rfc: "AAA010101AAA",
      razonSocial: "GRUPO DEMO", email: null, phone: null,
    };
    const facturas = [
      { id: "f-pue", customerId: "cust1", tipo: "INGRESO", uuid: "AAAA0001-0000-0000-0000-000000000001",
        serie: null, folio: "1", fecha: new Date("2026-05-01"), total: 100000, metodoPago: "PUE",
        conciliacionDetalles: [] },
      { id: "f-ppd-rep", customerId: "cust1", tipo: "INGRESO", uuid: "AAAA0002-0000-0000-0000-000000000002",
        serie: null, folio: "2", fecha: new Date("2026-06-01"), total: 200000, metodoPago: "PPD",
        conciliacionDetalles: [] },
      { id: "f-ppd-abierta", customerId: "cust1", tipo: "INGRESO", uuid: "AAAA0003-0000-0000-0000-000000000003",
        serie: null, folio: "3", fecha: new Date("2026-07-01"), total: 300000, metodoPago: "PPD",
        conciliacionDetalles: [] },
    ];
    const reps = [{ parentUuid: "aaaa0002-0000-0000-0000-000000000002", impPagado: 150000 }];
    return {
      customer: { findUnique: async () => contacto },
      invoice: { findMany: async () => facturas },
      pagoDoctoRelacionado: {
        findMany: async ({ where }: any) => reps.filter((r) => where.parentUuid.in.includes(r.parentUuid)),
      },
      vehiculo: { findMany: async () => [] },
      servicioVenta: { findMany: async () => [] },
      refaccionMovimiento: { findMany: async () => [] },
    };
  }

  it("PUE cobrada por definición; PPD por sus REPs; sin REP = saldo abierto", async () => {
    const p = await perfilContacto(fakeDbSinBancos() as never, "c1", "cust1", "CLIENTE");
    const por = Object.fromEntries(p!.facturas.map((f) => [f.id, f]));
    expect(por["f-pue"]).toMatchObject({ pagado: 100000, saldo: 0, repPendiente: 0 });
    expect(por["f-ppd-rep"]).toMatchObject({ pagado: 150000, amparadoRep: 150000, saldo: 50000, repPendiente: 0 });
    expect(por["f-ppd-abierta"]).toMatchObject({ pagado: 0, saldo: 300000 });
    expect(p!.resumen).toMatchObject({ totalFacturado: 600000, totalPagado: 250000, saldo: 350000 });
  });
});

describe("perfilContacto() — cuánto dejó el cliente", () => {
  it("utilidad por unidad = venta − costo − costos − comisión, y agrega el margen", async () => {
    const p = await perfilContacto(fakeDb() as never, "c1", "cust1", "CLIENTE");
    // 542,241.38 − 445,700.05 − 12,000 (costos) − 5,000 (comisión) = 79,541.33
    expect(p!.unidades[0].utilidad).toBeCloseTo(79541.33, 2);
    expect(p!.rentabilidad).toMatchObject({ unidades: 1, sinCosto: 0 });
    expect(p!.rentabilidad.utilidad).toBeCloseTo(79541.33, 2);
    expect(p!.rentabilidad.margen).toBeCloseTo(14.67, 1);
  });

  it("una unidad sin costo conocido NO inventa utilidad: queda fuera del agregado", async () => {
    const db = fakeDb() as never as { vehiculo: { findMany: () => Promise<unknown[]> } };
    db.vehiculo.findMany = async () => [
      { id: "v2", clienteId: "cust1", vin: "X", marca: "JAC", modelo: "JS4", anio: 2022,
        estado: "VENDIDO", fechaCompra: null, fechaVenta: new Date("2026-03-01"),
        costoCompra: 0, precioVenta: 300000, comisionMonto: 0, costos: [] },
    ];
    const p = await perfilContacto(db as never, "c1", "cust1", "CLIENTE");
    expect(p!.unidades[0].utilidad).toBeNull();
    expect(p!.rentabilidad).toMatchObject({ unidades: 0, utilidad: 0, sinCosto: 1 });
  });
});

describe("perfilContacto() — guardias", () => {
  it("contacto inexistente o de otra empresa → null", async () => {
    expect(await perfilContacto(fakeDb() as never, "c1", "nope", "CLIENTE")).toBeNull();
    expect(await perfilContacto(fakeDb() as never, "OTRA", "cust1", "CLIENTE")).toBeNull();
  });
});
