import { describe, it, expect } from "vitest";
import { derivarServicioDesdeCfdiSiAplica, extraerServicioCfdi } from "./auto-servicio";

const VIN = "3GALD255XTM007338";

const cfdiTaller = () => `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I">
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="78181500" Cantidad="1" Descripcion="SERVICIO DE 20 000 KM VIN ${VIN}" Importe="2500.00"/>
    <cfdi:Concepto ClaveProdServ="25171500" NoIdentificacion="1017100GD052" Cantidad="1" Descripcion="FILTRO DE ACEITE" Importe="350.00"/>
    <cfdi:Concepto ClaveProdServ="15121500" NoIdentificacion="ACEITE-5W30" Cantidad="4" Descripcion="ACEITE SINTETICO" Importe="720.00"/>
  </cfdi:Conceptos>
</cfdi:Comprobante>`;

function fakeDb(vehiculos: Record<string, string> = {}) {
  const servicios: Array<Record<string, unknown>> = [];
  return {
    _servicios: servicios,
    servicioVenta: {
      findUnique: async ({ where }: any) => servicios.find((s) => s.invoiceId === where.invoiceId) ?? null,
      create: async ({ data }: any) => {
        servicios.push({ ...data });
        return data;
      },
    },
    vehiculo: {
      findUnique: async ({ where }: any) => {
        const id = vehiculos[where.companyId_vin.vin];
        return id ? { id } : null;
      },
    },
  };
}

const base = { companyId: "c1", fecha: new Date("2026-08-08T00:00:00Z"), total: 4141.2 };

describe("extraerServicioCfdi()", () => {
  it("separa mano de obra vs refacciones y captura el VIN", () => {
    const d = extraerServicioCfdi(cfdiTaller());
    expect(d.esServicio).toBe(true);
    expect(d.manoObra).toBe(2500);
    expect(d.refacciones).toBe(1070); // 350 + 720
    expect(d.concepto).toContain("SERVICIO DE 20 000 KM");
    expect(d.vins).toEqual([VIN]);
  });

  it("una venta de unidad NO es servicio", () => {
    const conUnidad = `<cfdi:Comprobante TipoDeComprobante="I"><cfdi:Conceptos>
      <cfdi:Concepto ClaveProdServ="25101507" Cantidad="1" Importe="445700" Descripcion="UNIDAD CON SERVICIO DE ENTREGA">
        <cfdi:ComplementoConcepto><v:VentaVehiculos xmlns:v="http://www.sat.gob.mx/ventavehiculos" ClaveVehicular="1621710" Niv="${VIN}"/></cfdi:ComplementoConcepto>
      </cfdi:Concepto>
    </cfdi:Conceptos></cfdi:Comprobante>`;
    expect(extraerServicioCfdi(conUnidad).esServicio).toBe(false);
  });
});

describe("derivarServicioDesdeCfdiSiAplica()", () => {
  it("crea la venta de servicio ligando cliente y unidad por VIN; idempotente", async () => {
    const db = fakeDb({ [VIN]: "veh-1" });
    const creo = await derivarServicioDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-serv", tipo: "INGRESO", rawXml: cfdiTaller(), clienteId: "cli-1",
    });
    expect(creo).toBe(true);
    expect(db._servicios[0]).toMatchObject({
      invoiceId: "inv-serv", clienteId: "cli-1", vehiculoId: "veh-1",
      total: 4141.2, manoObra: 2500, refacciones: 1070,
    });
    const otra = await derivarServicioDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-serv", tipo: "INGRESO", rawXml: cfdiTaller(),
    });
    expect(otra).toBe(false);
    expect(db._servicios).toHaveLength(1);
  });

  it("EGRESO y notas de crédito no aplican", async () => {
    const db = fakeDb();
    expect(
      await derivarServicioDesdeCfdiSiAplica(db as never, {
        ...base, invoiceId: "x", tipo: "EGRESO", rawXml: cfdiTaller(),
      })
    ).toBe(false);
    expect(
      await derivarServicioDesdeCfdiSiAplica(db as never, {
        ...base, invoiceId: "y", tipo: "INGRESO",
        rawXml: cfdiTaller().replace('TipoDeComprobante="I"', 'TipoDeComprobante="E"'),
      })
    ).toBe(false);
  });
});
