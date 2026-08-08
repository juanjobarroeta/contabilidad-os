import { describe, it, expect } from "vitest";
import { derivarVehiculoDesdeCfdiSiAplica, derivarVehiculoInline } from "./auto-vehiculo";

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
function fakeDb(catalogo: Record<string, { empresa: string; modelo: string; version: string | null }> = {}) {
  const vehiculos = new Map<string, Record<string, unknown>>();
  const costos: Array<Record<string, unknown>> = [];
  let seq = 1;
  const clean = (d: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
  return {
    _vehiculos: vehiculos,
    _costos: costos,
    claveVehicularCatalogo: {
      findUnique: async ({ where }: any) => catalogo[where.clave] ?? null,
    },
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

  it("enriquecimiento: re-procesar la venta con cliente ya resuelto completa clienteId", async () => {
    const db = fakeDb();
    const args = { ...base, invoiceId: "inv-venta", tipo: "INGRESO", rawXml: cfdiVenta() };
    await derivarVehiculoDesdeCfdiSiAplica(db as never, args); // sin clienteId (aún no ligado)
    expect([...db._vehiculos.values()][0].clienteId).toBeNull();

    const r2 = await derivarVehiculoDesdeCfdiSiAplica(db as never, { ...args, clienteId: "cli1" });
    expect(r2?.actualizados).toBe(1);
    expect([...db._vehiculos.values()][0]).toMatchObject({ clienteId: "cli1", ventaInvoiceId: "inv-venta" });

    // Con el cliente ya puesto, otra corrida vuelve a ser no-op (no pisa).
    const r3 = await derivarVehiculoDesdeCfdiSiAplica(db as never, { ...args, clienteId: "cli2" });
    expect(r3?.actualizados).toBe(0);
    expect([...db._vehiculos.values()][0].clienteId).toBe("cli1");
  });

  it("resolver perezoso: la compra liga el proveedor find-or-create sólo cuando aplica", async () => {
    const db = fakeDb();
    let llamadas = 0;
    const resolverSupplierId = async () => { llamadas++; return "sup-lazy" }

    // CFDI sin vehículos: el resolver NO se invoca (no crear proveedores de más).
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-gasto", tipo: "EGRESO", resolverSupplierId,
      rawXml: `<cfdi:Comprobante><cfdi:Conceptos><cfdi:Concepto Descripcion="Papeleria" Importe="100"/></cfdi:Conceptos></cfdi:Comprobante>`,
    });
    expect(llamadas).toBe(0);

    // Compra real: se invoca una vez y liga el proveedor.
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: cfdiCompra(), resolverSupplierId,
    });
    expect(llamadas).toBe(1);
    expect([...db._vehiculos.values()][0]).toMatchObject({ supplierId: "sup-lazy" });
  });

  it("enriquecimiento: re-procesar la compra con proveedor ya resuelto completa supplierId", async () => {
    const db = fakeDb();
    const args = { ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: cfdiCompra() };
    await derivarVehiculoDesdeCfdiSiAplica(db as never, args); // sin supplierId
    const r2 = await derivarVehiculoDesdeCfdiSiAplica(db as never, { ...args, supplierId: "sup1" });
    expect(r2?.actualizados).toBe(1);
    expect([...db._vehiculos.values()][0]).toMatchObject({ supplierId: "sup1" });
    expect(db._costos).toHaveLength(2); // no duplicó costos
  });
});

describe("derivarVehiculoDesdeCfdiSiAplica() — catálogo de claves vehiculares", () => {
  it("con la clave en el catálogo, marca/modelo/versión salen del Anexo 15 (no heurística)", async () => {
    const db = fakeDb({
      "1621710": {
        empresa: "Giant Motors Latinoamérica, S.A. de C.V.",
        modelo: "Pick Up JAC 4 puertas Marca GML (nacional)",
        version: "Frison T9 Luxury, 2.0 lts., Turbo, 4x4",
      },
    });
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    const veh = [...db._vehiculos.values()][0];
    expect(veh).toMatchObject({
      marca: "JAC", // del texto del catálogo
      modelo: "Pick Up JAC 4 puertas", // modeloLimpio: sin "Marca GML (nacional)"
      version: "Frison T9 Luxury, 2.0 lts., Turbo, 4x4",
      claveVehicular: "1621710",
      autoCreado: true, // el distribuidor sigue confirmando
    });
  });

  it("reparación: una unidad POR REVISAR se re-nombra cuando la clave ya está en el catálogo", async () => {
    // CFDI de venta sin texto útil: nace POR REVISAR (catálogo vacío).
    const rawXml = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I">
      <cfdi:Conceptos><cfdi:Concepto ClaveProdServ="25101507" Descripcion="UNIDAD 2026" Importe="500000">
        <cfdi:ComplementoConcepto><ventavehiculos:VentaVehiculos xmlns:ventavehiculos="http://www.sat.gob.mx/ventavehiculos" ClaveVehicular="1621710" Niv="${VIN}"/></cfdi:ComplementoConcepto>
      </cfdi:Concepto></cfdi:Conceptos></cfdi:Comprobante>`;
    const catalogo = {
      "1621710": { empresa: "Giant Motors Latinoamérica, S.A. de C.V.", modelo: "Pick Up JAC 4 puertas Marca GML (nacional)", version: "Frison T9 Luxury" },
    };
    const db = fakeDb(catalogo);
    db.claveVehicularCatalogo.findUnique = (async () => null) as never; // catálogo aún no ingerido
    const args = { ...base, invoiceId: "inv-venta", tipo: "INGRESO", rawXml };
    await derivarVehiculoDesdeCfdiSiAplica(db as never, args);
    expect([...db._vehiculos.values()][0]).toMatchObject({ marca: "POR REVISAR", modelo: "POR REVISAR" });

    // Se ingiere el catálogo; la corrida profunda re-procesa el mismo CFDI.
    db.claveVehicularCatalogo.findUnique = async ({ where }: any) => (catalogo as any)[where.clave] ?? null;
    const r2 = await derivarVehiculoDesdeCfdiSiAplica(db as never, args);
    expect(r2?.actualizados).toBe(1);
    expect([...db._vehiculos.values()][0]).toMatchObject({
      marca: "JAC", modelo: "Pick Up JAC 4 puertas", version: "Frison T9 Luxury",
    });
  });

  it("sin la clave en el catálogo, cae a la heurística de texto", async () => {
    const db = fakeDb(); // catálogo vacío
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    const veh = [...db._vehiculos.values()][0];
    expect(veh.marca).toBe("JAC"); // heurística sobre la descripción
    expect(veh.modelo).toBe("FRISON T9 AT 4X4"); // NoIdentificacion
  });
});

describe("derivarVehiculoDesdeCfdiSiAplica() — conceptos que MENCIONAN un VIN sin ser la unidad", () => {
  const cfdiFlete = () => `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I">
    <cfdi:Conceptos>
      <cfdi:Concepto ClaveProdServ="78181500" Descripcion="TRASLADO DE UNIDAD VIN ${VIN}" Importe="610.03"/>
    </cfdi:Conceptos>
  </cfdi:Comprobante>`;

  it("un flete EGRESO con VIN NO crea unidad; si la unidad existe, se registra como costo", async () => {
    const db = fakeDb();
    // Sin unidad: no crea nada (antes inventaba una 'compra' de $610).
    const r1 = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-flete", tipo: "EGRESO", rawXml: cfdiFlete(),
    });
    expect(r1?.creados ?? 0).toBe(0);
    expect(db._vehiculos.size).toBe(0);

    // Con la unidad ya comprada: el flete se atribuye como VehiculoCosto.
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    const r2 = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-flete", tipo: "EGRESO", rawXml: cfdiFlete(),
    });
    expect(r2?.actualizados).toBe(1);
    expect(db._vehiculos.size).toBe(1);
    const flete = db._costos.find((c) => c.invoiceId === "inv-flete");
    expect(flete).toMatchObject({ tipo: "TRASLADO", monto: 610.03 });
    // Idempotente.
    const r3 = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-flete", tipo: "EGRESO", rawXml: cfdiFlete(),
    });
    expect(r3?.actualizados ?? 0).toBe(0);
    expect(db._costos.filter((c) => c.invoiceId === "inv-flete")).toHaveLength(1);
  });

  it("un INGRESO de servicio que menciona el VIN NO marca la unidad como vendida", async () => {
    const db = fakeDb();
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    const r = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-servicio", tipo: "INGRESO",
      rawXml: `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"><cfdi:Conceptos>
        <cfdi:Concepto ClaveProdServ="78181500" Descripcion="SERVICIO 10,000 KM VIN ${VIN}" Importe="3500.00"/>
      </cfdi:Conceptos></cfdi:Comprobante>`,
    });
    expect(r).toBeNull();
    expect([...db._vehiculos.values()][0].estado).toBe("DISPONIBLE");
  });

  it("una compra SIN complemento pero con ClaveProdServ de vehículo (2510xx) sí crea la unidad", async () => {
    const db = fakeDb();
    const r = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra-sc", tipo: "EGRESO",
      rawXml: `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"><cfdi:Conceptos>
        <cfdi:Concepto ClaveProdServ="25101507" NoIdentificacion="${VIN}" Descripcion="CAMIONETA JAC FRISON 2026" Importe="445700.05"/>
      </cfdi:Conceptos></cfdi:Comprobante>`,
    });
    expect(r?.creados).toBe(1);
    expect([...db._vehiculos.values()][0]).toMatchObject({ vin: VIN, estado: "DISPONIBLE", costoCompra: 445700.05 });
  });
});

describe("derivarVehiculoInline() — gate de módulo y proveedor por emisor", () => {
  const conXmlEmisor = () => `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I">
    <cfdi:Emisor Rfc="GML040609615" Nombre="GIANT MOTORS" RegimenFiscal="601"/>
    <cfdi:Conceptos>
      <cfdi:Concepto ClaveProdServ="25101507" Descripcion="JAC FRISON 2026 VIN: ${VIN}" Importe="445700.05">
        <cfdi:ComplementoConcepto><ventavehiculos:VentaVehiculos xmlns:ventavehiculos="http://www.sat.gob.mx/ventavehiculos" ClaveVehicular="1621710" Niv="${VIN}"/></cfdi:ComplementoConcepto>
      </cfdi:Concepto>
    </cfdi:Conceptos>
  </cfdi:Comprobante>`;

  function fakeDbConModulo(habilitado: boolean, companyId: string) {
    const db = fakeDb() as any;
    db.companyModule = {
      findFirst: async ({ where }: any) =>
        habilitado && where.companyId === companyId ? { id: "cm1" } : null,
    };
    db._suppliers = [] as Array<Record<string, unknown>>;
    db.supplier = {
      upsert: async ({ where, create }: any) => {
        const found = db._suppliers.find(
          (s: any) => s.companyId === where.companyId_rfc.companyId && s.rfc === where.companyId_rfc.rfc
        );
        if (found) return { id: found.id };
        const row = { id: `sup_${db._suppliers.length + 1}`, ...create };
        db._suppliers.push(row);
        return { id: row.id };
      },
    };
    return db;
  }

  it("sin el módulo AUTOMOTRIZ no deriva nada", async () => {
    const db = fakeDbConModulo(false, "c-sin");
    const r = await derivarVehiculoInline(db as never, {
      companyId: "c-sin", invoiceId: "i1", tipo: "EGRESO", fecha: base.fecha, rawXml: conXmlEmisor(),
    });
    expect(r).toBeNull();
    expect(db._vehiculos.size).toBe(0);
  });

  it("con el módulo, deriva y resuelve el proveedor por el RFC del emisor", async () => {
    const db = fakeDbConModulo(true, "c-auto");
    const r = await derivarVehiculoInline(db as never, {
      companyId: "c-auto", invoiceId: "i1", tipo: "EGRESO", fecha: base.fecha, rawXml: conXmlEmisor(),
    });
    expect(r?.creados).toBe(1);
    expect(db._suppliers[0]).toMatchObject({ rfc: "GML040609615", razonSocial: "GIANT MOTORS" });
    expect([...db._vehiculos.values()][0]).toMatchObject({ supplierId: "sup_1" });
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
