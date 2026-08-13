import { describe, it, expect } from "vitest";
import { armarDiagnostico, enmascarar } from "./diagnostico-unidades";
import { evaluarUnidad, conceptosConVeredicto, vinsDesdeTexto } from "./vin";

const VIN = "1C6RR6KG1RS180916";
const VIN2 = "3GALD255XTM007338";

function cfdi(conceptos: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" TipoDeComprobante="E">
  <cfdi:Conceptos>${conceptos}</cfdi:Conceptos>
</cfdi:Comprobante>`;
}

const concepto = (attrs: string) => `<cfdi:Concepto ${attrs} />`;

describe("evaluarUnidad() — reporta TODOS los candados que fallan", () => {
  it("un concepto limpio pasa y no reporta fallas", () => {
    const v = evaluarUnidad({
      claveProdServ: "25101611",
      cantidad: 1,
      importe: 300_000,
      vinsTexto: [VIN],
      nivComplemento: null,
    });
    expect(v.esUnidad).toBe(true);
    expect(v.fallas).toEqual([]);
    expect(v.niv).toBe(VIN);
  });

  it("el complemento con NIV válido gana sin pasar por los candados", () => {
    const v = evaluarUnidad({
      claveProdServ: "84111506", // clave que NO es de vehículo
      cantidad: 9,
      importe: 1,
      vinsTexto: [],
      nivComplemento: VIN,
    });
    expect(v.esUnidad).toBe(true);
    expect(v.porComplemento).toBe(true);
    expect(v.fallas).toEqual([]);
  });

  it("acumula varias fallas en el mismo concepto", () => {
    const v = evaluarUnidad({
      claveProdServ: "78181500",
      cantidad: 3,
      importe: 100,
      vinsTexto: [VIN, VIN2],
      nivComplemento: null,
    });
    expect(v.esUnidad).toBe(false);
    expect(v.fallas).toEqual([
      "clave_no_2510",
      "cantidad_mayor_1",
      "varios_vins_en_texto",
      "bajo_umbral",
    ]);
  });

  it("distingue sin_vin de varios_vins", () => {
    expect(
      evaluarUnidad({ claveProdServ: "2510", cantidad: 1, importe: 99_000, vinsTexto: [], nivComplemento: null }).fallas
    ).toEqual(["sin_vin_en_texto"]);
    expect(
      evaluarUnidad({ claveProdServ: "2510", cantidad: 1, importe: 99_000, vinsTexto: [VIN, VIN2], nivComplemento: null }).fallas
    ).toEqual(["varios_vins_en_texto"]);
  });
});

describe("conceptosConVeredicto() — el VIN pegado al texto siguiente", () => {
  // El patrón real de los seminuevos de Margom (74 conceptos / $41.4M en
  // 2025): el proveedor pega el VIN a la palabra siguiente y no hay segunda
  // aparición delimitada. La extracción acepta el prefijo de 17 sólo cuando
  // la cola es una palabra pegada conocida (VENTA…) — ver COLA_PEGADA_RE.
  it("un VIN pegado a «VENTA…» sin segunda aparición SÍ se extrae y deriva", () => {
    const xml = cfdi(
      concepto(
        `ClaveProdServ="25101611" Cantidad="1" Importe="900000" Descripcion="VENTA VEHICULO RAM ${VIN}VENTA DE VEHICULO USADO EN LAS CONDICIONES QUE SE ENCUENTRA"`
      )
    );
    const [c] = conceptosConVeredicto(xml);
    expect(c.vinsTexto).toEqual([VIN]);
    expect(c.veredicto.esUnidad).toBe(true);
  });

  it("pegado + delimitado del MISMO VIN colapsan a uno (Set)", () => {
    const xml = cfdi(
      concepto(
        `ClaveProdServ="25101611" Cantidad="1" Importe="900000" Descripcion="RAM 1500 ${VIN}VENTA DE VEHICULO USADO NO. SERIE: ${VIN}"`
      )
    );
    const [c] = conceptosConVeredicto(xml);
    expect(c.vinsTexto).toEqual([VIN]);
    expect(c.veredicto.esUnidad).toBe(true);
  });

  // Los tres cortes que NO deben hacerse — cada uno inventaría un VIN
  // plausible pero equivocado (los tres vienen de datos reales de producción).
  it("VIN con un dígito de más no se corta a 17: la cola «1» no es palabra pegada", () => {
    // «Núm de VIN 3GALD2555TM0007571» — 18 caracteres: capturar los primeros
    // 17 produciría un VIN que se ve bien y es falso.
    expect(vinsDesdeTexto("Instalación de Película para JAC Frison T9 Núm de VIN 3GALD2555TM0007571")).toEqual([]);
  });

  it("referencias largas (NRU, peajes) no producen VINs", () => {
    expect(vinsDesdeTexto("NRU 017932000249835816D4498967FEB060 (20/03/2026)")).toEqual([]);
    expect(vinsDesdeTexto("PEAJE-2111206728920260121082535VIA1122196")).toEqual([]);
  });

  it("una corrida que empieza con basura de clase VIN no se corta por en medio", () => {
    // El vecino izquierdo alfanumérico anula el ancla izquierda: no hay
    // ventana válida y no se extrae nada.
    expect(vinsDesdeTexto(`XX${VIN}`)).toEqual([]);
  });

  it("dos VINs distintos en el texto sí bloquean la derivación", () => {
    const xml = cfdi(
      concepto(
        `ClaveProdServ="25101611" Cantidad="1" Importe="900000" Descripcion="LOTE ${VIN} Y ${VIN2}"`
      )
    );
    const [c] = conceptosConVeredicto(xml);
    expect(c.vinsTexto).toHaveLength(2);
    expect(c.veredicto.fallas).toEqual(["varios_vins_en_texto"]);
  });
});

describe("armarDiagnostico()", () => {
  it("cuenta VINs, separa la falla única y no se traga los conceptos que sí pasan", () => {
    const facturas = [
      {
        id: "a",
        rawXml: cfdi(
          concepto(`ClaveProdServ="25101611" Cantidad="1" Importe="900000" Descripcion="RAM ${VIN} Y ${VIN2}"`) +
            // Un flete en la misma factura: no es 2510, no debe contarse.
            concepto(`ClaveProdServ="78101800" Cantidad="1" Importe="5000" Descripcion="FLETE ${VIN}"`)
        ),
      },
      {
        id: "b",
        rawXml: cfdi(
          concepto(`ClaveProdServ="25101500" Cantidad="1" Importe="10000" Descripcion="NISSAN ${VIN}"`)
        ),
      },
      { id: "c", rawXml: null },
    ];

    const d = armarDiagnostico(facturas);

    expect(d.facturas).toBe(2); // la del rawXml nulo no entra
    expect(d.sinXml).toBe(1);
    expect(d.conceptos).toBe(2); // sólo los 2510xx
    expect(d.monto).toBe(910_000);

    // El conteo real de VINs, que es la pregunta de origen.
    expect(d.distribucionVins).toEqual([
      { vins: 1, conceptos: 1, monto: 10_000 },
      { vins: 2, conceptos: 1, monto: 900_000 },
    ]);

    const soloUmbral = d.porFalla.find((f) => f.motivo === "bajo_umbral");
    expect(soloUmbral).toMatchObject({ conceptos: 1, soloEsta: 1, montoSoloEsta: 10_000 });
    const varios = d.porFalla.find((f) => f.motivo === "varios_vins_en_texto");
    expect(varios).toMatchObject({ conceptos: 1, soloEsta: 1, montoSoloEsta: 900_000 });
  });

  it("marca los conceptos que pasan todos los candados — ahí la falla no es el gate", () => {
    const d = armarDiagnostico([
      {
        id: "a",
        rawXml: cfdi(
          concepto(`ClaveProdServ="25101611" Cantidad="1" Importe="900000" Descripcion="RAM ${VIN}"`)
        ),
      },
    ]);
    expect(d.pasanTodos).toBe(1);
    expect(d.montoPasanTodos).toBe(900_000);
    expect(d.porFalla).toEqual([]);
  });
});

describe("enmascarar()", () => {
  it("oculta el VIN y recorta", () => {
    expect(enmascarar(`RAM 1500 ${VIN}`)).toBe("RAM 1500 1C6R…16");
    expect(enmascarar("x".repeat(200)).endsWith("…")).toBe(true);
    expect(enmascarar(null)).toBe("");
  });
});
