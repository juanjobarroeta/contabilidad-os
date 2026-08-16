import { describe, it, expect } from "vitest";
import { tipoUnidadDesdeCfdi } from "./auto-vehiculo";
import { derivarVehiculoDesdeCfdiSiAplica, derivarVehiculoInline } from "./auto-vehiculo";
import { esConversionDeCarroceria } from "./vin";

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
  const expediente: Array<Record<string, unknown>> = [];
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
      // unidadVigentePorVin: la del ciclo MÁS ALTO de ese VIN. La búsqueda por
      // compraInvoiceId/ventaInvoiceId (idempotencia a través de ciclos) filtra
      // igual que Prisma cuando el where trae esos campos.
      findFirst: async ({ where, select }: any) => {
        const hits = [...vehiculos.values()].filter(
          (v) =>
            v.companyId === where.companyId &&
            v.vin === where.vin &&
            (where.compraInvoiceId == null || v.compraInvoiceId === where.compraInvoiceId) &&
            (where.ventaInvoiceId == null || v.ventaInvoiceId === where.ventaInvoiceId)
        );
        if (hits.length === 0) return null;
        hits.sort((a, b) => ((b.ciclo as number) ?? 1) - ((a.ciclo as number) ?? 1));
        const row = { ...hits[0] };
        if (!select) return row;
        return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
      },
      create: async ({ data }: any) => {
        const id = `veh_${seq++}`;
        const row = { id, ciclo: 1, ...clean(data) };
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
      // El derivador REEMPLAZA sus propias filas al volver a derivar una
      // factura; respeta autoCreado para no tirar costos capturados a mano.
      deleteMany: async ({ where }: any) => {
        let n = 0;
        for (let i = costos.length - 1; i >= 0; i--) {
          const c = costos[i];
          if (where.vehiculoId != null && c.vehiculoId !== where.vehiculoId) continue;
          if (where.invoiceId != null && c.invoiceId !== where.invoiceId) continue;
          if (where.autoCreado != null && (c.autoCreado ?? false) !== where.autoCreado) continue;
          costos.splice(i, 1);
          n++;
        }
        return { count: n };
      },
    },
    _expediente: expediente,
    vehiculoCfdi: {
      upsert: async ({ where, create, update }: any) => {
        const found = expediente.find(
          (e) =>
            e.vehiculoId === where.vehiculoId_invoiceId.vehiculoId &&
            e.invoiceId === where.vehiculoId_invoiceId.invoiceId
        );
        if (found) Object.assign(found, update);
        else expediente.push({ ...create });
        return found ?? create;
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

  it("la unidad RETIRADA por cancelación vuelve al piso cuando llega su compra buena", async () => {
    const db = fakeDb();
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-muerta", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    // Se cancela la compra: la reversión desliga y retira (no estuvo en piso).
    const veh = [...db._vehiculos.values()][0];
    Object.assign(veh, { compraInvoiceId: null, costoCompra: 0, estado: "CANCELADO" });

    // Llega la sustituta. El orden importa: la cancelación se detecta ANTES de
    // descargar el CFDI nuevo, así que este caso es el normal, no el raro.
    const r = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-viva", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    expect(r).toMatchObject({ creados: 0, actualizados: 1 });
    expect(db._vehiculos.size).toBe(1); // no duplica el VIN
    expect(veh).toMatchObject({
      estado: "DISPONIBLE", compraInvoiceId: "inv-viva", costoCompra: 445700.05,
    });
  });

  it("una compra normal NO revive nada: el estado no se pisa", async () => {
    const db = fakeDb();
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    const veh = [...db._vehiculos.values()][0];
    // Vendida y desligada de su compra (p.ej. la preparación se desligó): que
    // llegue la compra buena no la debe sacar de VENDIDO.
    Object.assign(veh, { compraInvoiceId: null, estado: "VENDIDO", ventaInvoiceId: "inv-venta" });
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra-2", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    expect(veh.estado).toBe("VENDIDO");
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
    // La marca ya la da el WMI del VIN (3GA = planta León); el modelo sigue roto.
    expect([...db._vehiculos.values()][0]).toMatchObject({ marca: "JAC", modelo: "POR REVISAR" });

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
    // Idempotente POR REEMPLAZO: reporta trabajo pero no duplica.
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

describe("derivarVehiculoDesdeCfdiSiAplica() — preparación multi-unidad con clave de vehículo (caso Margom)", () => {
  const VIN2 = "3GABAC221VM009265";
  // Caso real: "PREPARACION DE 5 UNIDADES…" con ClaveProdServ 25101500,
  // Cantidad 5 y los VINs en la descripción — NO es una unidad, es un costo
  // repartido entre las unidades mencionadas.
  const cfdiPreparacion = () => `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I">
    <cfdi:Conceptos>
      <cfdi:Concepto ClaveProdServ="25101500" Cantidad="2" Descripcion="PREPARACION DE 2 UNIDADES JAC PARA ENTREGA CON NUMERO DE SERIE : ${VIN}, ${VIN2}" Importe="1800.00"/>
    </cfdi:Conceptos>
  </cfdi:Comprobante>`;

  it("no crea unidades; reparte el importe como costo entre las unidades existentes", async () => {
    const db = fakeDb();
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    const r = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-prep", tipo: "EGRESO", rawXml: cfdiPreparacion(),
    });
    expect(r?.creados ?? 0).toBe(0);
    expect(db._vehiculos.size).toBe(1); // no inventó la unidad del VIN2
    const costoPrep = db._costos.find((c) => c.invoiceId === "inv-prep");
    expect(costoPrep?.monto).toBe(900); // 1800 repartido entre 2 VINs
  });

  it("una compra 2510 sin complemento con importe de servicio (< umbral) tampoco es unidad", async () => {
    const db = fakeDb();
    const r = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-gestoria", tipo: "EGRESO",
      rawXml: `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I"><cfdi:Conceptos>
        <cfdi:Concepto ClaveProdServ="25101500" Descripcion="GESTORIA UNIDAD ${VIN}" Importe="4500.00"/>
      </cfdi:Conceptos></cfdi:Comprobante>`,
    });
    expect(r?.creados ?? 0).toBe(0);
    expect(db._vehiculos.size).toBe(0);
  });

  it("reparación: una unidad cuya 'compra' era la preparación se desliga y el importe queda como costo", async () => {
    const db = fakeDb();
    // Simula el estado viejo: unidad creada por la factura de preparación.
    await (db as any).vehiculo.create({
      data: {
        companyId: "c1", vin: VIN, marca: "JAC", modelo: "X", anio: 2026, tipo: "NUEVO",
        estado: "DISPONIBLE", costoCompra: 1800, fechaCompra: base.fecha,
        compraInvoiceId: "inv-prep", autoCreado: true,
      },
    });
    ;(db as any).vehiculoCosto.deleteMany = async ({ where }: any) => {
      for (let i = db._costos.length - 1; i >= 0; i--) {
        if (db._costos[i].vehiculoId === where.vehiculoId && db._costos[i].invoiceId === where.invoiceId) db._costos.splice(i, 1);
      }
      return { count: 0 };
    };
    const r = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-prep", tipo: "EGRESO", rawXml: cfdiPreparacion(),
    });
    expect(r?.actualizados).toBeGreaterThanOrEqual(1);
    const unidad = [...db._vehiculos.values()][0];
    expect(unidad).toMatchObject({ compraInvoiceId: null, costoCompra: 0 });
    expect(db._costos.find((c) => c.invoiceId === "inv-prep")?.monto).toBe(900);
  });
});

describe("derivarVehiculoDesdeCfdiSiAplica() — expediente CFDI del VIN", () => {
  it("compra y venta quedan en el expediente con su rol; el flete como COSTO", async () => {
    const db = fakeDb();
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-venta", tipo: "INGRESO", rawXml: cfdiVenta(),
    });
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-flete", tipo: "EGRESO",
      rawXml: `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I"><cfdi:Conceptos>
        <cfdi:Concepto ClaveProdServ="78181500" Descripcion="TRASLADO VIN ${VIN}" Importe="610"/>
      </cfdi:Conceptos></cfdi:Comprobante>`,
    });
    const roles = Object.fromEntries(db._expediente.map((e: any) => [e.invoiceId, e.rol]));
    expect(roles).toEqual({ "inv-compra": "COMPRA", "inv-venta": "VENTA", "inv-flete": "COSTO" });
  });

  it("segunda venta sin relación 04 queda como DUPLICADA; servicio como SERVICIO", async () => {
    const db = fakeDb();
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-venta", tipo: "INGRESO", rawXml: cfdiVenta(),
    });
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-venta-2", tipo: "INGRESO", rawXml: cfdiVenta(),
    });
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-serv", tipo: "INGRESO",
      rawXml: `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I"><cfdi:Conceptos>
        <cfdi:Concepto ClaveProdServ="78181500" Descripcion="SERVICIO 10K VIN ${VIN}" Importe="3500"/>
      </cfdi:Conceptos></cfdi:Comprobante>`,
    });
    const roles = Object.fromEntries(db._expediente.map((e: any) => [e.invoiceId, e.rol]));
    expect(roles).toEqual({ "inv-venta": "VENTA", "inv-venta-2": "DUPLICADA", "inv-serv": "SERVICIO" });
  });
});

describe("derivarVehiculoDesdeCfdiSiAplica() — refacturación (TipoRelacion 04)", () => {
  const UUID_A = "AAAA1111-2222-3333-4444-555566667777";
  const ventaConUuid = () => cfdiVenta(); // liga como inv-venta-a (uuid A en fake)
  const refactura = (importe: number) => `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:ventavehiculos="http://www.sat.gob.mx/ventavehiculos" TipoDeComprobante="I">
    <cfdi:CfdiRelacionados TipoRelacion="04"><cfdi:CfdiRelacionado UUID="${UUID_A.toLowerCase()}"/></cfdi:CfdiRelacionados>
    <cfdi:Conceptos>
      <cfdi:Concepto ClaveProdServ="25101507" Descripcion="Unidad JAC FRISON T9 (refacturada)" Importe="${importe}">
        <cfdi:ComplementoConcepto><ventavehiculos:VentaVehiculos ClaveVehicular="1621710" Niv="${VIN}"/></cfdi:ComplementoConcepto>
      </cfdi:Concepto>
    </cfdi:Conceptos>
  </cfdi:Comprobante>`;

  function conInvoices(db: ReturnType<typeof fakeDb>, uuids: Record<string, string>) {
    (db as any).invoice = {
      findUnique: async ({ where }: any) => (uuids[where.id] ? { uuid: uuids[where.id] } : null),
    };
    (db as any).vehiculoCosto.deleteMany = async ({ where }: any) => {
      const antes = db._costos.length;
      for (let i = db._costos.length - 1; i >= 0; i--) {
        if (db._costos[i].vehiculoId === where.vehiculoId && db._costos[i].invoiceId === where.invoiceId) db._costos.splice(i, 1);
      }
      return { count: antes - db._costos.length };
    };
    return db;
  }

  it("la refactura que SUSTITUYE a la venta ligada se re-liga (precio y factura vigentes)", async () => {
    const db = conInvoices(fakeDb(), { "inv-venta-a": UUID_A });
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-venta-a", tipo: "INGRESO", rawXml: ventaConUuid(), clienteId: "cli-err",
    });
    // Otra venta del MISMO VIN sin relación 04 (p. ej. factura a financiera): NO re-liga.
    const r0 = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-venta-x", tipo: "INGRESO", rawXml: ventaConUuid(),
    });
    expect(r0?.actualizados).toBe(0);
    expect([...db._vehiculos.values()][0].ventaInvoiceId).toBe("inv-venta-a");

    // La refactura con TipoRelacion 04 → UUID A sí re-liga, con su precio.
    const r = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-refactura", tipo: "INGRESO", rawXml: refactura(560000), clienteId: "cli-bien",
    });
    expect(r?.actualizados).toBe(1);
    expect([...db._vehiculos.values()][0]).toMatchObject({
      ventaInvoiceId: "inv-refactura", precioVenta: 560000, clienteId: "cli-bien", estado: "VENDIDO",
    });
  });
});

describe("derivarVehiculoDesdeCfdiSiAplica() — términos del proveedor (CondicionesDePago)", () => {
  const compraConCredito = () => `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I" CondicionesDePago="CREDITO 30 DIAS">
    <cfdi:Conceptos>
      <cfdi:Concepto ClaveProdServ="25101507" Descripcion="JAC FRISON 2026" Importe="445700.05">
        <cfdi:ComplementoConcepto><ventavehiculos:VentaVehiculos xmlns:ventavehiculos="http://www.sat.gob.mx/ventavehiculos" ClaveVehicular="1621710" Niv="${VIN}"/></cfdi:ComplementoConcepto>
      </cfdi:Concepto>
    </cfdi:Conceptos>
  </cfdi:Comprobante>`;

  function conTerms(db: ReturnType<typeof fakeDb>, existentes: string[] = []) {
    const terms: Array<Record<string, unknown>> = existentes.map((supplierId) => ({ id: `t-${supplierId}`, supplierId, diasCredito: 99 }));
    (db as any)._terms = terms;
    (db as any).supplierTerms = {
      findUnique: async ({ where }: any) => terms.find((t) => t.supplierId === where.supplierId) ?? null,
      create: async ({ data }: any) => { const row = { id: `t-${data.supplierId}`, ...data }; terms.push(row); return row; },
    };
    return db;
  }

  it("una compra a crédito crea SupplierTerms del proveedor (30 días)", async () => {
    const db = conTerms(fakeDb());
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: compraConCredito(), supplierId: "sup1",
    });
    expect((db as any)._terms).toEqual([
      expect.objectContaining({ supplierId: "sup1", tieneCredito: true, diasCredito: 30 }),
    ]);
  });

  it("términos ya capturados nunca se pisan", async () => {
    const db = conTerms(fakeDb(), ["sup1"]);
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: compraConCredito(), supplierId: "sup1",
    });
    expect((db as any)._terms).toEqual([expect.objectContaining({ diasCredito: 99 })]);
  });
});

describe("derivarVehiculoDesdeCfdiSiAplica() — notas de crédito y número de motor", () => {
  const notaCredito = () => `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="E">
    <cfdi:Conceptos>
      <cfdi:Concepto ClaveProdServ="25101507" Descripcion="REBATE PROGRAMA VIN ${VIN}" Importe="15000.00"/>
    </cfdi:Conceptos>
  </cfdi:Comprobante>`;

  it("nota de crédito EGRESO: netea el costo de la unidad (monto negativo), jamás crea unidades", async () => {
    const db = fakeDb();
    // Sin unidad: no hace nada.
    const r0 = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-nc", tipo: "EGRESO", rawXml: notaCredito(),
    });
    expect(r0?.actualizados ?? 0).toBe(0);
    expect(db._vehiculos.size).toBe(0);

    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    const r = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-nc", tipo: "EGRESO", rawXml: notaCredito(),
    });
    expect(r?.actualizados).toBe(1);
    const nc = db._costos.find((c) => c.invoiceId === "inv-nc");
    expect(nc).toMatchObject({ monto: -15000, tipo: "OTRO" });
    // La utilidad reconstruida ya incluye el rebate (costos suman negativo).
    // Idempotente POR REEMPLAZO: volver a derivar sustituye la fila del
    // derivador en vez de saltarse la factura. Reporta trabajo —eso es lo que
    // permite que una mejora del parseo corrija la historia— pero NO duplica,
    // que es el invariante que importa.
    const r2 = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-nc", tipo: "EGRESO", rawXml: notaCredito(),
    });
    expect(db._costos.filter((c) => c.invoiceId === "inv-nc")).toHaveLength(1);
  });

  it("nota de crédito emitida a un cliente (INGRESO): NC_CLIENTE positiva, sin tocar el estado", async () => {
    const db = fakeDb();
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    const r = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-nc-cli", tipo: "INGRESO", rawXml: notaCredito(),
    });
    // Menos-ingreso ligado a la unidad: monto POSITIVO tipo NC_CLIENTE (resta
    // utilidad), jamás cambia el estado ni crea unidades.
    expect(r?.actualizados).toBe(1);
    const nc = db._costos.find((c) => c.invoiceId === "inv-nc-cli");
    expect(nc).toMatchObject({ monto: 15000, tipo: "NC_CLIENTE" });
    expect([...db._vehiculos.values()][0].estado).toBe("DISPONIBLE");
    // Idempotente POR REEMPLAZO (ver arriba): no duplica.
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-nc-cli", tipo: "INGRESO", rawXml: notaCredito(),
    });
    expect(db._costos.filter((c) => c.invoiceId === "inv-nc-cli")).toHaveLength(1);
  });

  it("número de motor: se captura al crear y se completa en re-corridas", async () => {
    const db = fakeDb();
    const conMotor = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I">
      <cfdi:Conceptos><cfdi:Concepto ClaveProdServ="25101507" Descripcion="JAC FRISON 2026 VIN: ${VIN} NO. MOTOR: HFC4GA3-1234567" Importe="445700.05">
        <cfdi:ComplementoConcepto><ventavehiculos:VentaVehiculos xmlns:ventavehiculos="http://www.sat.gob.mx/ventavehiculos" ClaveVehicular="1621710" Niv="${VIN}"/></cfdi:ComplementoConcepto>
      </cfdi:Concepto></cfdi:Conceptos></cfdi:Comprobante>`;
    // Compra sin motor en el texto → queda null.
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    expect([...db._vehiculos.values()][0].numeroMotor ?? null).toBeNull();
    // La venta sí lo menciona → re-corrida lo completa.
    const r = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-venta", tipo: "INGRESO", rawXml: conMotor,
    });
    expect(r?.actualizados).toBeGreaterThanOrEqual(1);
    expect([...db._vehiculos.values()][0].numeroMotor).toBe("HFC4GA3-1234567");
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

describe("tipoUnidadDesdeCfdi() — el seminuevo existe", () => {
  it("el CFDI dice que es usado y el tablero debe creerle", () => {
    // Margom compraba $7.8M de autos usados al año y el tablero reportaba
    // «Seminuevos: 0 unidades»: el tipo estaba escrito a mano como NUEVO.
    for (const descripcion of [
      "AUTO USADO MARCA JAC, VERSION SEI4 PRO CONNECT, MODELO 2024",
      "UNIDAD SEMINUEVA EN LAS CONDICIONES EN LAS QUE SE ENCUENTRA",
      "VEHICULO USADO PICK UP JAC FRISON T9 AT LUXURY 4X4",
    ]) {
      expect(tipoUnidadDesdeCfdi({ descripcion })).toBe("SEMINUEVO");
    }
  });

  it("la clave vehicular NO convierte en nueva a una unidad usada", () => {
    // La factura de un seminuevo también declara la clave vehicular, en el
    // texto: «AUTO USADO MARCA JAC… CLAVE VEHICULAR 0622304». Un atajo por
    // claveVehicular pisaba la frase que dice «usado» y dejó 321 unidades de
    // Margom marcadas NUEVO.
    expect(
      tipoUnidadDesdeCfdi({
        descripcion: "AUTO USADO MARCA JAC, VERSION SEI4 PRO CONNECT, CLAVE VEHICULAR 0622304.",
        claveVehicular: "0622304",
      })
    ).toBe("SEMINUEVO");
  });

  it("sin señal de usado, se asume nueva", () => {
    expect(tipoUnidadDesdeCfdi({ descripcion: "JAC SEI7 PRO LIMITED 2026" })).toBe("NUEVO");
  });
});

describe("conversión de carrocería sobre unidad propia — es COSTO, no compra duplicada", () => {
  // El negocio (Margom): compra el chasis, le paga a un carrocero la conversión
  // —ambulancia, patrulla, unidad médica— y vende la unidad convertida, casi
  // siempre a gobierno. El carrocero factura con clave 2510xx y el VIN del
  // chasis, así que llegaba al derivador pareciendo una SEGUNDA compra de la
  // misma unidad: quedaba DUPLICADA, su costo caía en «Otros gastos» y la
  // unidad se vendía convertida contra el costo del chasis pelón.
  // Medido en producción (2026-08): 6 conceptos, $17,535,141.
  const VIN_CHASIS = "3GAPJ1A94SM016533";
  const cfdiConversion = () => `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I">
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="25101503" NoIdentificacion="CONV" Descripcion="Conversión de Unidad Médica Móvil unidad de la mujer (Mastografía) con blindaje, montada sobre camión marca JAC X350, número de serie ${VIN_CHASIS}" Importe="5358620.86"/>
  </cfdi:Conceptos>
</cfdi:Comprobante>`;

  it("capitaliza la conversión a la unidad existente en vez de archivarla DUPLICADA", async () => {
    const db = fakeDb();
    // La unidad ya es nuestra: chasis comprado en su momento.
    await db.vehiculo.create({
      data: {
        companyId: base.companyId, vin: VIN_CHASIS, marca: "JAC", modelo: "X350",
        anio: 2025, costoCompra: 419228, compraInvoiceId: "inv_chasis", estado: "DISPONIBLE",
      },
    } as never);

    const res = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv_conversion", tipo: "EGRESO", rawXml: cfdiConversion(),
    });

    // No se crea una segunda unidad fantasma de $5.36M.
    expect(db._vehiculos.size).toBe(1);
    expect(res?.creados ?? 0).toBe(0);

    // La conversión queda como COSTO de la unidad, capitalizado.
    const costos = db._costos.filter((c) => c.invoiceId === "inv_conversion");
    expect(costos).toHaveLength(1);
    expect(costos[0].monto).toBeCloseTo(5358620.86, 2);
    expect(costos[0].tipo).toBe("ACONDICIONAMIENTO");

    // Y el expediente lo dice: COSTO, no DUPLICADA.
    const mencion = db._expediente.find((e) => e.invoiceId === "inv_conversion");
    expect(mencion?.rol).toBe("COSTO");
  });

  it("si la unidad NO es nuestra, comprar una ya convertida SIGUE siendo compra", async () => {
    // 6 conceptos / $2.3M en producción: unidades que llegaron ya convertidas.
    // El candado exige que el VIN ya tenga compra ligada, así que éstas no se
    // tocan y se derivan como la unidad que son.
    const db = fakeDb();
    const res = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv_convertida", tipo: "EGRESO", rawXml: cfdiConversion(),
    });
    expect(res?.creados).toBe(1);
    expect(db._vehiculos.size).toBe(1);
  });
});

describe("esConversionDeCarroceria() — la regla, validada contra el corpus real", () => {
  it("reconoce las conversiones que Margom paga a terceros", () => {
    for (const d of [
      "Conversión de Unidad Médica Móvil unidad de la mujer (Mastografía) con blindaje de acuerdo con la Nom 229-2020",
      "Venta de ambulancia tipo II, en chasis Jac Sunray de su propiedad con número de serie LJ11",
      "CARROCERIA PARA PATRULLA CON TORRETA Y ROTULACION",
      "BLINDAJE NIVEL III SOBRE UNIDAD",
    ]) {
      expect(esConversionDeCarroceria(d)).toBe(true);
    }
  });

  it("NO se confunde con la recompra de un seminuevo", () => {
    // «AUTO USADO» manda aunque el texto mencione equipamiento: son los 94
    // conceptos / $29.2M de recompras, que son un ciclo nuevo, no un costo.
    for (const d of [
      "AUTO USADO MARCA JAC, VERSION PICK UP JAC FRISON T9 AT LUXURY 4X4 DOBLE CABINA",
      "VEHICULO USADO EN LAS CONDICIONES QUE SE ENCUENTRA CON ADAPTACIONES",
    ]) {
      expect(esConversionDeCarroceria(d)).toBe(false);
    }
  });

  it("no marca una compra normal de unidad nueva", () => {
    expect(esConversionDeCarroceria("VEHICULO NUEVO JAC FRISON T9 4X4 Modelo:2026")).toBe(false);
    expect(esConversionDeCarroceria(null)).toBe(false);
  });
});

describe("recompra de seminueva — segundo ciclo de vida del mismo VIN", () => {
  // Margom vende una unidad, el cliente la regresa años después, la agencia la
  // recompra usada y la vuelve a vender. Con el unique en (companyId, vin) eso
  // era imposible: la segunda compra chocaba con la unidad ya vendida, se
  // archivaba DUPLICADA, su costo caía en «Otros gastos», y la unidad conservaba
  // el costo de la PRIMERA compra contra el precio de la SEGUNDA venta.
  // Medido en producción (2026-08): 94 conceptos, $29,170,088.
  const cfdiRecompra = () => `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I">
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="25101611" NoIdentificacion="USADO" Descripcion="AUTO USADO MARCA JAC, VERSION FRISON T9, MOD. 2024, NUM. SERIE ${VIN}" Importe="170000.00"/>
  </cfdi:Conceptos>
</cfdi:Comprobante>`;

  async function unidadDelPrimerCiclo(db: ReturnType<typeof fakeDb>) {
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra-1", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-venta-1", tipo: "INGRESO", rawXml: cfdiVenta(),
    });
  }

  it("crea un renglón NUEVO en ciclo 2 y deja intacta la historia del ciclo 1", async () => {
    const db = fakeDb();
    await unidadDelPrimerCiclo(db);
    expect(db._vehiculos.size).toBe(1);

    const r = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, fecha: new Date("2026-05-02T00:00:00Z"),
      invoiceId: "inv-recompra", tipo: "EGRESO", rawXml: cfdiRecompra(),
    });

    expect(r?.creados).toBe(1);
    expect(db._vehiculos.size).toBe(2);

    const ciclos = [...db._vehiculos.values()].sort(
      (a, b) => (a.ciclo as number) - (b.ciclo as number)
    );
    // Ciclo 1: su compra y su venta originales, sin tocar.
    expect(ciclos[0]).toMatchObject({
      ciclo: 1, compraInvoiceId: "inv-compra-1", ventaInvoiceId: "inv-venta-1",
      costoCompra: 445700.05,
    });
    // Ciclo 2: la recompra, disponible otra vez y ya marcada SEMINUEVO.
    expect(ciclos[1]).toMatchObject({
      ciclo: 2, vin: VIN, compraInvoiceId: "inv-recompra", costoCompra: 170000,
      estado: "DISPONIBLE", tipo: "SEMINUEVO",
    });
    expect(ciclos[1].ventaInvoiceId).toBeUndefined();
  });

  it("la venta posterior cae en el ciclo 2, no en el 1", async () => {
    const db = fakeDb();
    await unidadDelPrimerCiclo(db);
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-recompra", tipo: "EGRESO", rawXml: cfdiRecompra(),
    });
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, fecha: new Date("2026-06-01T00:00:00Z"),
      invoiceId: "inv-venta-2", tipo: "INGRESO", rawXml: cfdiVenta(),
    });

    const ciclos = [...db._vehiculos.values()].sort(
      (a, b) => (a.ciclo as number) - (b.ciclo as number)
    );
    expect(ciclos[0].ventaInvoiceId).toBe("inv-venta-1"); // el ciclo viejo no se toca
    expect(ciclos[1]).toMatchObject({ ciclo: 2, ventaInvoiceId: "inv-venta-2", estado: "VENDIDO" });
    // La utilidad del segundo ciclo sale de SU propio costo: 542,241 − 170,000.
    expect((ciclos[1].precioVenta as number) - (ciclos[1].costoCompra as number)).toBeCloseTo(372241.38, 2);
  });

  it("REPLAY de la recompra: no pare un tercer ciclo (idempotencia a través de ciclos)", async () => {
    // La repesca reprocesa CFDIs viejos en cualquier orden. Antes, el replay se
    // comparaba sólo contra el ciclo VIGENTE: como el vigente ya estaba vendido
    // y el texto dice «usado», cada replay paría una «recompra» fantasma. En
    // producción: 153 VINs con ventas anteriores a su compra o la misma venta
    // en dos ciclos, $7.5M de piso fantasma al corte 2026-06.
    const db = fakeDb();
    await unidadDelPrimerCiclo(db);
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-recompra", tipo: "EGRESO", rawXml: cfdiRecompra(),
    });
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, fecha: new Date("2026-06-01T00:00:00Z"),
      invoiceId: "inv-venta-2", tipo: "INGRESO", rawXml: cfdiVenta(),
    });
    expect(db._vehiculos.size).toBe(2); // ciclo 1 y 2, ambos cerrados

    const r = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-recompra", tipo: "EGRESO", rawXml: cfdiRecompra(),
    });
    expect(r?.creados ?? 0).toBe(0);
    expect(db._vehiculos.size).toBe(2); // ningún ciclo 3
  });

  it("REPLAY de una venta vieja: no se liga a OTRO ciclo", async () => {
    // El otro lado del mismo bug: ciclo 1 vendido con inv-venta-1, la recompra
    // abre el ciclo 2, y el replay de inv-venta-1 encontraba al vigente (ciclo
    // 2, abierto) y le colgaba la venta VIEJA — la misma venta en dos ciclos, y
    // el piso pierde una unidad que sí está.
    const db = fakeDb();
    await unidadDelPrimerCiclo(db);
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-recompra", tipo: "EGRESO", rawXml: cfdiRecompra(),
    });

    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-venta-1", tipo: "INGRESO", rawXml: cfdiVenta(),
    });

    const ciclos = [...db._vehiculos.values()].sort(
      (a, b) => (a.ciclo as number) - (b.ciclo as number)
    );
    expect(ciclos[0].ventaInvoiceId).toBe("inv-venta-1"); // sigue en el ciclo 1
    expect(ciclos[1].ventaInvoiceId).toBeUndefined(); // el ciclo 2 sigue en piso
    expect(ciclos[1].estado).toBe("DISPONIBLE");
  });

  it("una factura repetida sobre unidad vendida SIGUE siendo DUPLICADA si no dice usado", async () => {
    // El candado no es «el ciclo está cerrado» sino «el ciclo está cerrado Y el
    // texto dice usado». Una segunda factura de unidad nueva sobre un VIN ya
    // vendido es una duplicada, no una recompra.
    const db = fakeDb();
    await unidadDelPrimerCiclo(db);
    const r = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-repetida", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    expect(r?.creados).toBe(0);
    expect(db._vehiculos.size).toBe(1);
    expect(db._expediente.find((e) => e.invoiceId === "inv-repetida")?.rol).toBe("DUPLICADA");
  });

  it("no abre ciclo si la unidad aún NO se ha vendido", async () => {
    // Comprada y en piso: una segunda factura no es recompra, es duplicada.
    const db = fakeDb();
    await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-compra-1", tipo: "EGRESO", rawXml: cfdiCompra(),
    });
    const r = await derivarVehiculoDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-recompra", tipo: "EGRESO", rawXml: cfdiRecompra(),
    });
    expect(r?.creados).toBe(0);
    expect(db._vehiculos.size).toBe(1);
  });
});
