import { describe, it, expect } from "vitest";
import { perfilContactoHospital } from "./perfil-contacto";

// Fake Prisma mínimo: un contacto que es a la vez cliente (le facturamos PPD y
// PUE, con conciliación parcial y REP en minúsculas) y proveedor (nos facturó
// PPD pagada en banco sin REP), con convenio, episodios y pacientes ligados.
const HOY = new Date(2026, 8, 3);
const hace = (d: number) => new Date(HOY.getTime() - d * 86_400_000);

function fakeDb() {
  const contacto = { id: "cust1", companyId: "c1", rfc: "GNP9211244P0", razonSocial: "GNP SEGUROS", email: null, phone: null };
  const facturas = [
    { id: "f-ppd", companyId: "c1", customerId: "cust1", tipo: "INGRESO", status: "STAMPED", tipoSat: "I",
      uuid: "F5BF65B3-86C0-11F1-9687-578EFC729F41", serie: "A", folio: "1187", facturapiId: null, rawXml: null,
      fecha: hace(45), total: 100000, metodoPago: "PPD", conciliacionDetalles: [{ montoAsignado: 30000 }] },
    { id: "f-pue", companyId: "c1", customerId: "cust1", tipo: "INGRESO", status: "STAMPED", tipoSat: "I",
      uuid: "11111111-0000-0000-0000-000000000001", serie: "A", folio: "1190", facturapiId: null, rawXml: null,
      fecha: hace(100), total: 10000, metodoPago: "PUE", conciliacionDetalles: [] },
    { id: "f-vieja", companyId: "c1", customerId: "cust1", tipo: "INGRESO", status: "STAMPED", tipoSat: "I",
      uuid: "11111111-0000-0000-0000-000000000002", serie: "A", folio: "0900", facturapiId: null, rawXml: null,
      fecha: hace(120), total: 5000, metodoPago: "PPD", conciliacionDetalles: [] },
    { id: "nc-1", companyId: "c1", customerId: "cust1", tipo: "INGRESO", status: "STAMPED", tipoSat: "E",
      uuid: "11111111-0000-0000-0000-000000000003", serie: "NC", folio: "12", facturapiId: null, rawXml: null,
      fecha: hace(10), total: 1500, metodoPago: "PUE", conciliacionDetalles: [] },
    { id: "f-compra", companyId: "c1", customerId: "cust1", tipo: "EGRESO", status: "STAMPED", tipoSat: "I",
      uuid: "8BFA8033-0833-11F1-B0A5-D1046CE86093", serie: "P", folio: "77", facturapiId: null, rawXml: null,
      fecha: hace(20), total: 8000, metodoPago: "PPD", conciliacionDetalles: [{ montoAsignado: -8000 }] },
  ];
  const reps = [{ parentUuid: "f5bf65b3-86c0-11f1-9687-578efc729f41", impPagado: 40000 }];
  const pagadores = [{ id: "pag1", companyId: "c1", customerId: "cust1", nombre: "GNP Seguros", tipo: "ASEGURADORA", plazoDias: 45, topeAutorizacion: 60000, vigenciaFin: null, activo: true }];
  const episodios = [
    { id: "e1", companyId: "c1", folio: "HOSP-2026-0418", estado: "POSTOPERATORIO", fechaIngreso: hace(2), fechaAlta: null, customerId: "cust1", pagadorId: null,
      paciente: { nombre: "María", apellidoPaterno: "Ortega", apellidoMaterno: "Ruiz" },
      cargos: [{ importe: 1000, ivaTasa: 0.16 }, { importe: 500, ivaTasa: null }] },
    { id: "e2", companyId: "c1", folio: "HOSP-2026-0300", estado: "ALTA", fechaIngreso: hace(30), fechaAlta: hace(27), customerId: "otro", pagadorId: "pag1",
      paciente: { nombre: "Jorge", apellidoPaterno: "Peña", apellidoMaterno: null },
      cargos: [{ importe: 200, ivaTasa: 0, cancelado: false }] },
  ];
  const pacientes = [{ id: "p1", companyId: "c1", customerId: "cust1", nombre: "María", apellidoPaterno: "Ortega", apellidoMaterno: "Ruiz", activo: true }];
  return {
    customer: { findUnique: async ({ where }: any) => (where.id === contacto.id ? contacto : null) },
    invoice: {
      findMany: async ({ where }: any) => facturas.filter((f) => f.tipo === where.tipo && f.customerId === where.customerId),
    },
    pagoDoctoRelacionado: {
      findMany: async ({ where }: any) => reps.filter((r) => where.parentUuid.in.includes(r.parentUuid)),
    },
    hospPagador: { findMany: async ({ where }: any) => pagadores.filter((p) => p.customerId === where.customerId) },
    hospEpisodio: {
      findMany: async ({ where }: any) =>
        episodios.filter((e) => {
          const [porReceptor, porPagador] = where.OR;
          return e.customerId === porReceptor.customerId || pagadores.some((p) => p.id === e.pagadorId && p.customerId === porPagador.pagador.customerId);
        }),
    },
    hospPaciente: { findMany: async ({ where }: any) => pacientes.filter((p) => p.customerId === where.customerId) },
  };
}

describe("perfilContactoHospital() — lado CLIENTE", () => {
  it("evidencia de cobro, aging del saldo abierto y lo hospitalario ligado", async () => {
    const p = (await perfilContactoHospital(fakeDb() as never, "c1", "cust1", "CLIENTE", HOY))!;
    expect(p.direccion).toBe("CLIENTE");
    expect(p.resumen.numFacturas).toBe(3); // la nota de crédito va aparte
    expect(p.notasCredito).toHaveLength(1);
    expect(p.resumen.totalNotasCredito).toBe(1500);

    const ppd = p.facturas.find((f) => f.id === "f-ppd")!;
    expect(ppd.amparadoRep).toBe(40000); // REP en minúsculas empata
    expect(ppd.pagado).toBe(40000); // max(conciliado 30k, REP 40k)
    expect(ppd.saldo).toBe(60000);
    expect(ppd.aging).toBe("31-60");
    const pue = p.facturas.find((f) => f.id === "f-pue")!;
    expect(pue.saldo).toBe(0);

    expect(p.aging).toEqual({ "0-30": 0, "31-60": 60000, "61-90": 0, "90+": 5000 });
    expect(p.resumen.saldo).toBe(65000);
    expect(p.resumen.masDe30).toBe(65000);

    expect(p.pagador).toMatchObject({ id: "pag1", nombre: "GNP Seguros", topeAutorizacion: 60000 });
    expect(p.episodios.map((e) => [e.folio, e.via, e.total])).toEqual([
      ["HOSP-2026-0418", "RECEPTOR", 1660],
      ["HOSP-2026-0300", "PAGADOR", 200],
    ]);
    expect(p.pacientes).toEqual([{ id: "p1", nombre: "María Ortega Ruiz", activo: true }]);
  });
});

describe("perfilContactoHospital() — lado PROVEEDOR", () => {
  it("mira las EGRESO: pagada en banco sin REP = REP pendiente", async () => {
    const p = (await perfilContactoHospital(fakeDb() as never, "c1", "cust1", "PROVEEDOR", HOY))!;
    expect(p.resumen.numFacturas).toBe(1);
    const f = p.facturas[0];
    expect(f).toMatchObject({ pagado: 8000, saldo: 0, repPendiente: 8000, aging: "0-30" });
    expect(p.resumen.repPendienteMonto).toBe(8000);
    expect(p.aging).toEqual({ "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 });
  });
  it("fail-closed: contacto de otra empresa → null", async () => {
    expect(await perfilContactoHospital(fakeDb() as never, "c2", "cust1", "CLIENTE", HOY)).toBeNull();
  });
});
