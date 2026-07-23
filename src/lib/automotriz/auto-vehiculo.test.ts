import { describe, it, expect } from "vitest";
import { derivarVehiculoDesdeCfdiSiAplica } from "./auto-vehiculo";

const VIN = "3GALD255XTM007338";

const cfdiCompra = () => `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I">
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="25101507" NoIdentificacion="FRISON T9 AT 4X4" Descripcion="VEHICULO NUEVO JAC FRISON T9 4X4 Modelo:2026 VIN: ${VIN}" Importe="445700.05">
      <cfdi:ComplementoConcepto><ventavehiculos:VentaVehiculos xmlns:ventavehiculos="http://www.sat.gob.mx/ventavehiculos" ClaveVehicular="1621710" Niv="${VIN}"/></cfdi:ComplementoConcepto>
    </cfdi:Concepto>
    <cfdi:Concepto ClaveProdServ="78101803" NoIdentificacion="TRASLADO" Descripcion="TRASLADO FRISON T9" Importe="10300.00"/>
    <cfdi:Concepto ClaveProdServ="84131503" NoIdentificacion="SEGURO" Descripcion="SEGURO FRISON T9" Importe="1687.17"/>
  </cfdi:Conceptos>
</cfdi:Comprobante>`;

const cfdiVenta = () => `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:ventavehiculos="http://www.sat.gob.mx/ventavehiculos" TipoDeComprobante="I">
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="25101507" NoIdentificacion="FRISON T9 LUXURY 26" Descripcion="Unidad JAC FRISON T9 LUXURY Modelo:2026" Importe="542241.38">
      <cfdi:ComplementoConcepto><ventavehiculos:VentaVehiculos ClaveVehicular="1621710" Niv="${VIN}"/></cfdi:ComplementoConcepto>
    </cfdi:Concepto>
  </cfdi:Conceptos>
</cfdi:Comprobante>`;

// Prisma-client mínimo en memoria: sólo los métodos que usa el derivador.
function fakeDb() {
  const vehiculos = new Map<string, Record<string, unknown>>();
  const costos: Array<Record<string, unknown>> = [];
  let seq = 1;
  const clean = (d: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
  return {
    _vehiculos: vehiculos,
    _costos: costos,
    vehiculo: {
      findUnique: async ({ where }: any) => {
        const { companyId, vin } = where.companyId_vin;
        for (const v of vehiculos.values())
          if (v.companyId === companyId && v.vin === vin) return { ...v };
        return null;
      },
      create: async ({ data }: any) => {
        const id = `veh_${seq++}`;
        const row = { id, ...clean(data) };
        vehiculos.set(id, row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = vehiculos.get(where.id)!;
        Object.assign(row, clean(data));
        return row;
      },
    },
    vehiculoCosto: {
      findFirst: async ({ where }: any) =>
        costos.find((c) => c.vehiculoId === where.vehiculoId && c.invoiceId === where.invoiceId) ??
        null,
      createMany: async ({ data }: any) => {
        for (const d of data) costos.push({ ...d });
        return { count: data.length };
      },
    },
  };
}

const base = { companyId: "c1", fecha: new Date("2026-02-12T00:00:00Z") };

describe("derivarVehiculoDesdeCfdiSiAplica() — compra", () => {
  it("crea la unidad DISPONIBLE con costo, clave y costos de traslado/seguro", async () => {
    const db = fakeDb();
    const r = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: cfdiCompra(), supplierId: "sup1",
    });
    expect(r).toEqual({ creados: 1, actualizados: 0, vins: [VIN] });
    const veh = [...db._vehiculos.values()][0];
    expect(veh).toMatchObject({
      vin: VIN, estado: "DISPONIBLE", costoCompra: 445700.05, compraInvoiceId: "inv-compra",
      supplierId: "sup1", claveVehicular: "1621710", autoCreado: true, marca: "JAC", anio: 2026,
    });
    expect(veh.modelo).toBe("FRISON T9 AT 4X4"); // del NoIdentificacion
    expect(db._costos).toHaveLength(2);
    expect(db._costos.find((c) => c.tipo === "TRASLADO")?.monto).toBe(10300);
    expect(db._costos.find((c) => c.tipo === "OTRO")?.monto).toBe(1687.17); // seguro → OTRO
  });

  it("es idempotente: reprocesar la compra no duplica unidad ni costos", async () => {
    const db = fakeDb();
    const args = { ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: cfdiCompra() };
    await derivarVehiculoDesdeCfdiSiAplica(db as never, args);
    const r2 = await derivarVehiculoDesdeCfdiSiAplica(db as never, args);
    expect(r2?.creados).toBe(0);
    expect(db._vehiculos.size).toBe(1);
    expect(db._costos).toHaveLength(2);
  });
});

describe("derivarVehiculoDesdeCfdiSiAplica() — venta y round-trip", () => {
  it("marca VENDIDO una unidad existente y liga el CFDI de venta", async () => {
    const db = fakeDb();
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    const r = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, fecha: new Date("2026-07-23T00:00:00Z"), invoiceId: "inv-venta", tipo: "INGRESO",
      rawXml: cfdiVenta(), clienteId: "cli1",
    });
    expect(r).toEqual({ creados: 0, actualizados: 1, vins: [VIN] });
    const veh = [...db._vehiculos.values()][0];
    expect(veh).toMatchObject({
      estado: "VENDIDO", precioVenta: 542241.38, ventaInvoiceId: "inv-venta", clienteId: "cli1",
      costoCompra: 445700.05, // se conserva
    });
    // Utilidad por VIN reconstruida del stream (menos costos capturados aparte).
    const costos = db._costos.reduce((s, c) => s + (c.monto as number), 0);
    expect((veh.precioVenta as number) - (veh.costoCompra as number) - costos).toBeCloseTo(84554.16, 2);
    expect(db._vehiculos.size).toBe(1); // no duplicó
  });

  it("venta antes que compra: crea la unidad ya VENDIDA; la compra posterior la enriquece", async () => {
    const db = fakeDb();
    const r1 = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-venta", tipo: "INGRESO", rawXml: cfdiVenta(),
    });
    expect(r1?.creados).toBe(1);
    expect([...db._vehiculos.values()][0]).toMatchObject({ estado: "VENDIDO" });
    expect([...db._vehiculos.values()][0].costoCompra).toBeUndefined();

    const r2 = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    expect(r2?.actualizados).toBe(1);
    const veh = [...db._vehiculos.values()][0];
    expect(veh).toMatchObject({ estado: "VENDIDO", costoCompra: 445700.05, compraInvoiceId: "inv-compra" });
    expect(db._vehiculos.size).toBe(1);
  });

  it("venta idempotente: reprocesar no cambia nada", async () => {
    const db = fakeDb();
    const args = { ...base, invoiceId: "inv-venta", tipo: "INGRESO", rawXml: cfdiVenta() };
    await derivarVehiculoDesdeCfdiSiAplica(db as never, args);
    const r2 = await derivarVehiculoDesdeCfdiSiAplica(db as never, args);
    expect(r2?.actualizados).toBe(0);
    expect(r2?.creados).toBe(0);
  });
});

describe("derivarVehiculoDesdeCfdiSiAplica() — no aplica", () => {
  it("devuelve null sin rawXml, sin vehículos, o en tipo que no mueve inventario", async () => {
    const db = fakeDb();
    expect(await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "x", tipo: "EGRESO", rawXml: null,
    })).toBeNull();
    expect(await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "x", tipo: "EGRESO",
      rawXml: `<cfdi:Comprobante><cfdi:Conceptos><cfdi:Concepto Descripcion="Servicio" Importe="100"/></cfdi:Conceptos></cfdi:Comprobante>`,
    })).toBeNull();
    expect(await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "x", tipo: "PAGO", rawXml: cfdiCompra(),
    })).toBeNull();
  });
});
