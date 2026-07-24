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
      costoCompra: 445700.05, precioVenta: 542241.38 },
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

describe("perfilContacto() — guardias", () => {
  it("contacto inexistente o de otra empresa → null", async () => {
    expect(await perfilContacto(fakeDb() as never, "c1", "nope", "CLIENTE")).toBeNull();
    expect(await perfilContacto(fakeDb() as never, "OTRA", "cust1", "CLIENTE")).toBeNull();
  });
});
