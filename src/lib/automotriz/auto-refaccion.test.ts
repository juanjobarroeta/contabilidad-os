import { describe, it, expect } from "vitest";
import { derivarRefaccionesDesdeCfdiSiAplica, extraerRefaccionesCfdi } from "./auto-refaccion";

const cfdiRefacciones = (tipo = "I") => `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="${tipo}">
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="25171500" NoIdentificacion="1017100GD052" Cantidad="4" ValorUnitario="350.00" Descripcion="FILTRO DE ACEITE JAC" Importe="1400.00"/>
    <cfdi:Concepto ClaveProdServ="25172800" NoIdentificacion="3501100GD010" Cantidad="2" ValorUnitario="1250.00" Descripcion="BALATA DELANTERA FRISON" Importe="2500.00"/>
    <cfdi:Concepto ClaveProdServ="15121500" NoIdentificacion="ACEITE-5W30" Cantidad="12" ValorUnitario="180.00" Descripcion="ACEITE SINTETICO 5W30" Importe="2160.00"/>
    <cfdi:Concepto ClaveProdServ="25171500" NoIdentificacion="1017100GD052" Cantidad="2" ValorUnitario="350.00" Descripcion="FILTRO DE ACEITE JAC" Importe="700.00"/>
  </cfdi:Conceptos>
</cfdi:Comprobante>`;

function fakeDb() {
  const refacciones: Array<Record<string, unknown>> = [];
  const movs: Array<Record<string, unknown>> = [];
  let seq = 1;
  return {
    _refacciones: refacciones,
    _movs: movs,
    refaccion: {
      upsert: async ({ where, create, update }: any) => {
        const found = refacciones.find(
          (r) =>
            r.companyId === where.companyId_numeroParte.companyId &&
            r.numeroParte === where.companyId_numeroParte.numeroParte
        );
        if (found) {
          Object.assign(found, Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined)));
          return { id: found.id };
        }
        const row = { id: `ref_${seq++}`, ...create };
        refacciones.push(row);
        return { id: row.id };
      },
    },
    refaccionMovimiento: {
      findUnique: async ({ where }: any) => {
        const k = where.refaccionId_invoiceId_tipo;
        return (
          movs.find(
            (m) => m.refaccionId === k.refaccionId && m.invoiceId === k.invoiceId && m.tipo === k.tipo
          ) ?? null
        );
      },
      create: async ({ data }: any) => {
        movs.push({ ...data });
        return data;
      },
    },
  };
}

const base = { companyId: "c1", fecha: new Date("2026-03-01T00:00:00Z") };

describe("extraerRefaccionesCfdi()", () => {
  it("extrae líneas con número de parte y salta unidades, VINs y servicios", () => {
    const conUnidad = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I"><cfdi:Conceptos>
      <cfdi:Concepto ClaveProdServ="25101507" NoIdentificacion="FRISON-T9" Cantidad="1" Importe="445700" Descripcion="UNIDAD VIN: 3GALD255XTM007338">
        <cfdi:ComplementoConcepto><v:VentaVehiculos xmlns:v="http://www.sat.gob.mx/ventavehiculos" ClaveVehicular="1621710" Niv="3GALD255XTM007338"/></cfdi:ComplementoConcepto>
      </cfdi:Concepto>
      <cfdi:Concepto ClaveProdServ="78181500" NoIdentificacion="FOLIO-123" Cantidad="1" Importe="900" Descripcion="SERVICIO"/>
      <cfdi:Concepto ClaveProdServ="25171500" NoIdentificacion="P-1" Cantidad="1" ValorUnitario="100" Importe="100" Descripcion="PARTE"/>
    </cfdi:Conceptos></cfdi:Comprobante>`;
    const lineas = extraerRefaccionesCfdi(conUnidad);
    expect(lineas.map((l) => l.numeroParte)).toEqual(["P-1"]);
  });
});

describe("derivarRefaccionesDesdeCfdiSiAplica()", () => {
  it("compra: crea catálogo y ENTRADAS agregando líneas repetidas", async () => {
    const db = fakeDb();
    const r = await derivarRefaccionesDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-ref", tipo: "EGRESO", rawXml: cfdiRefacciones(),
    });
    expect(r).toEqual({ partes: 3, movimientos: 3 });
    const filtro = db._movs.find((m: any) =>
      db._refacciones.find((x: any) => x.id === m.refaccionId)?.numeroParte === "1017100GD052"
    ) as any;
    expect(filtro.cantidad).toBe(6); // 4 + 2 líneas repetidas
    expect(filtro.montoUnitario).toBe(350);
    expect(filtro.tipo).toBe("ENTRADA_COMPRA");
  });

  it("venta de mostrador: SALIDAS con cantidad negativa y último precio", async () => {
    const db = fakeDb();
    await derivarRefaccionesDesdeCfdiSiAplica(db as never, {
      ...base, invoiceId: "inv-venta", tipo: "INGRESO", rawXml: cfdiRefacciones(),
    });
    const balata = db._movs.find((m: any) =>
      db._refacciones.find((x: any) => x.id === m.refaccionId)?.numeroParte === "3501100GD010"
    ) as any;
    expect(balata.tipo).toBe("SALIDA_VENTA");
    expect(balata.cantidad).toBe(-2);
    const cat = db._refacciones.find((x: any) => x.numeroParte === "3501100GD010") as any;
    expect(cat.ultimoPrecio).toBe(1250);
  });

  it("idempotente por (parte, CFDI, tipo); notas de crédito y pocas líneas no aplican", async () => {
    const db = fakeDb();
    const args = { ...base, invoiceId: "inv-ref", tipo: "EGRESO", rawXml: cfdiRefacciones() };
    await derivarRefaccionesDesdeCfdiSiAplica(db as never, args);
    const r2 = await derivarRefaccionesDesdeCfdiSiAplica(db as never, args);
    expect(r2?.movimientos).toBe(0);
    expect(db._movs).toHaveLength(3);

    expect(
      await derivarRefaccionesDesdeCfdiSiAplica(db as never, {
        ...base, invoiceId: "inv-nc", tipo: "EGRESO", rawXml: cfdiRefacciones("E"),
      })
    ).toBeNull();
    expect(
      await derivarRefaccionesDesdeCfdiSiAplica(db as never, {
        ...base, invoiceId: "inv-2lineas", tipo: "EGRESO",
        rawXml: `<cfdi:Comprobante TipoDeComprobante="I"><cfdi:Conceptos>
          <cfdi:Concepto ClaveProdServ="25171500" NoIdentificacion="A" Cantidad="1" Importe="10" Descripcion="X"/>
          <cfdi:Concepto ClaveProdServ="25171500" NoIdentificacion="B" Cantidad="1" Importe="10" Descripcion="Y"/>
        </cfdi:Conceptos></cfdi:Comprobante>`,
      })
    ).toBeNull();
  });
});
