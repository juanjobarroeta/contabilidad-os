import { describe, it, expect } from "vitest";
import { emisorDesdeCfdi, numeroMotorDesdeTexto, tipoComprobanteDesdeCfdi } from "./vin";

describe("tipoComprobanteDesdeCfdi() y numeroMotorDesdeTexto()", () => {
  it("extrae el TipoDeComprobante del nodo Comprobante", () => {
    expect(tipoComprobanteDesdeCfdi(`<cfdi:Comprobante Version="4.0" TipoDeComprobante="E" Total="100">`)).toBe("E");
    expect(tipoComprobanteDesdeCfdi(`<cfdi:Comprobante Version="4.0">`)).toBeNull();
  });
  it("número de motor desde el texto libre, sin confundirlo con el VIN", () => {
    expect(numeroMotorDesdeTexto("JAC FRISON VIN: 3GALD255XTM007338 NO. MOTOR: 4GA3-1234567")).toBe("4GA3-1234567");
    expect(numeroMotorDesdeTexto("MOTOR HFC4GA3-4D12345678")).toBe("HFC4GA3-4D12345678");
    expect(numeroMotorDesdeTexto("NUM DE MOTOR 3GALD255XTM007338")).toBeNull(); // es un VIN
    expect(numeroMotorDesdeTexto("VEHICULO SIN DATO")).toBeNull();
  });
});

describe("emisorDesdeCfdi()", () => {
  it("extrae RFC y nombre del emisor sin importar el orden de atributos", () => {
    expect(emisorDesdeCfdi(`<cfdi:Emisor Nombre="GIANT MOTORS" Rfc="GML040609615" RegimenFiscal="601"/>`))
      .toEqual({ rfc: "GML040609615", nombre: "GIANT MOTORS" });
  });
  it("null sin emisor o con RFC inválido", () => {
    expect(emisorDesdeCfdi(`<cfdi:Comprobante/>`)).toBeNull();
    expect(emisorDesdeCfdi(`<cfdi:Emisor Rfc="XX" Nombre="X"/>`)).toBeNull();
  });
});
import {
  esVinValido,
  extraerDatosVehiculoCfdi,
  vinDesdeDescripcion,
  tipoCostoDesdeConcepto,
} from "./vin";

// Fixtures modelados sobre dos CFDIs reales de una agencia (JAC Frison T9), con
// emisor/receptor anonimizados: la MISMA unidad comprada a la planta y luego
// vendida al cliente. El NIV 3GALD255XTM007338 ata ambas facturas.
const VIN = "3GALD255XTM007338";

// COMPRA: planta (emisor) → agencia (receptor). Línea de vehículo + seguro + traslado.
const CFDI_COMPRA = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Serie="JC" Folio="119267" TipoDeComprobante="I" SubTotal="457687.22" Total="530917.18">
  <cfdi:Emisor Rfc="GML040609615" Nombre="PLANTA DISTRIBUIDORA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="AMA170817NK1" Nombre="AGENCIA DEMO" UsoCFDI="G01"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="25101507" NoIdentificacion="FRISON T9 AT 4X4" Cantidad="1.000000" ClaveUnidad="XVN" Unidad="Vehiculo" Descripcion="VEHICULO NUEVO PICK UP JAC FRISON T9 4X4 VIN: 3GALD255XTM007338 NO MOTOR: D9S0006450" ValorUnitario="445700.050000" Importe="445700.050000" ObjetoImp="02">
      <cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado TasaOCuota="0.160000" Base="445700.050000" Importe="71312.008000" Impuesto="002" TipoFactor="Tasa"/></cfdi:Traslados></cfdi:Impuestos>
      <cfdi:ComplementoConcepto>
        <ventavehiculos:VentaVehiculos xmlns:ventavehiculos="http://www.sat.gob.mx/ventavehiculos" version="1.1" ClaveVehicular="1621710" Niv="3GALD255XTM007338"/>
      </cfdi:ComplementoConcepto>
    </cfdi:Concepto>
    <cfdi:Concepto ClaveProdServ="84131503" NoIdentificacion="SEGURO" Cantidad="1.000000" ClaveUnidad="E48" Unidad="Servicio" Descripcion="SEGURO FRISON T9 AT LUXURY 4X4" ValorUnitario="1687.170000" Importe="1687.170000" ObjetoImp="02">
      <cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado TasaOCuota="0.160000" Base="1687.170000" Importe="269.947200" Impuesto="002" TipoFactor="Tasa"/></cfdi:Traslados></cfdi:Impuestos>
    </cfdi:Concepto>
    <cfdi:Concepto ClaveProdServ="78101803" NoIdentificacion="TRASLADO" Cantidad="1.000000" ClaveUnidad="E48" Unidad="Servicio" Descripcion="TRASLADO FRISON T9 LUXURY 4X4 AT" ValorUnitario="10300.000000" Importe="10300.000000" ObjetoImp="02">
      <cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado TasaOCuota="0.160000" Base="10300.000000" Importe="1648.000000" Impuesto="002" TipoFactor="Tasa"/></cfdi:Traslados></cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
</cfdi:Comprobante>`;

// VENTA: agencia (emisor) → cliente. Sólo la línea del vehículo; el VIN vive
// SÓLO en el complemento (la descripción no lo trae).
const CFDI_VENTA = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:ventavehiculos="http://www.sat.gob.mx/ventavehiculos" Version="4.0" Serie="NVS" Folio="2257" TipoDeComprobante="I" SubTotal="542241.38" Total="629000.00">
  <cfdi:Emisor Rfc="AMA170817NK1" Nombre="AGENCIA DEMO" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="PUBLICO EN GENERAL" DomicilioFiscalReceptor="70613" RegimenFiscalReceptor="616" UsoCFDI="S01"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="25101507" NoIdentificacion="FRISON T9 LUXURY 26" Cantidad="1.000000" ClaveUnidad="XVN" Unidad="Vehículo" Descripcion="Unidad GML VEHICULO NUEVO PICK UP JAC FRISON T9 LUXURY 4X4 Modelo:2026 No Motor:D9S0006450" ValorUnitario="542241.379321" ObjetoImp="02" Importe="542241.379321">
      <cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="542241.379321" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="86758.620691"/></cfdi:Traslados></cfdi:Impuestos>
      <cfdi:ComplementoConcepto>
        <ventavehiculos:VentaVehiculos version="1.1" ClaveVehicular="1621710" Niv="3GALD255XTM007338"/>
      </cfdi:ComplementoConcepto>
    </cfdi:Concepto>
  </cfdi:Conceptos>
</cfdi:Comprobante>`;

describe("esVinValido()", () => {
  it("acepta un VIN real de 17 caracteres (sin I/O/Q)", () => {
    expect(esVinValido(VIN)).toBe(true);
    expect(esVinValido("3galD255xtm007338")).toBe(true); // normaliza mayúsculas
  });
  it("rechaza longitudes incorrectas o caracteres prohibidos I/O/Q", () => {
    expect(esVinValido("3GALD255XTM00733")).toBe(false); // 16
    expect(esVinValido("3GALD255XTM0073380")).toBe(false); // 18
    expect(esVinValido("3GALD255XTM00733I")).toBe(false); // contiene I
    expect(esVinValido("3GALD255XTMO07338")).toBe(false); // contiene O
  });
});

describe("extraerDatosVehiculoCfdi() — factura de COMPRA", () => {
  const datos = extraerDatosVehiculoCfdi(CFDI_COMPRA);

  it("extrae la unidad del complemento VentaVehiculos", () => {
    expect(datos.vehiculos).toHaveLength(1);
    expect(datos.vehiculos[0].niv).toBe(VIN);
    expect(datos.vehiculos[0].claveVehicular).toBe("1621710");
    expect(datos.vehiculos[0].importe).toBeCloseTo(445700.05, 2);
  });

  it("separa seguro y traslado como otros conceptos (candidatos a VehiculoCosto)", () => {
    expect(datos.otrosConceptos).toHaveLength(2);
    const traslado = datos.otrosConceptos.find((c) => c.claveProdServ === "78101803");
    const seguro = datos.otrosConceptos.find((c) => c.claveProdServ === "84131503");
    expect(traslado?.importe).toBeCloseTo(10300, 2);
    expect(seguro?.importe).toBeCloseTo(1687.17, 2);
  });
});

describe("extraerDatosVehiculoCfdi() — factura de VENTA", () => {
  const datos = extraerDatosVehiculoCfdi(CFDI_VENTA);

  it("extrae el MISMO VIN aunque la descripción no lo contenga", () => {
    expect(datos.vehiculos).toHaveLength(1);
    expect(datos.vehiculos[0].niv).toBe(VIN);
    expect(datos.vehiculos[0].descripcion).not.toContain(VIN); // sólo está en el complemento
    expect(datos.vehiculos[0].importe).toBeCloseTo(542241.38, 2);
  });

  it("no reporta otros conceptos (venta de una sola línea)", () => {
    expect(datos.otrosConceptos).toHaveLength(0);
  });
});

describe("round-trip: la misma unidad comprada y vendida", () => {
  it("el VIN de la compra y el de la venta coinciden (permite atar utilidad por VIN)", () => {
    const compra = extraerDatosVehiculoCfdi(CFDI_COMPRA).vehiculos[0];
    const venta = extraerDatosVehiculoCfdi(CFDI_VENTA).vehiculos[0];
    expect(compra.niv).toBe(venta.niv);

    const costos = extraerDatosVehiculoCfdi(CFDI_COMPRA).otrosConceptos.reduce(
      (s, c) => s + c.importe,
      0
    );
    const utilidad = venta.importe - compra.importe - costos;
    expect(utilidad).toBeCloseTo(84554.16, 2); // 542241.38 − 445700.05 − 11987.17
  });
});

describe("vinDesdeDescripcion()", () => {
  it("encuentra el VIN etiquetado en texto de compra", () => {
    expect(vinDesdeDescripcion("VEHICULO ... VIN: 3GALD255XTM007338 NO MOTOR: X")).toBe(VIN);
  });
  it("devuelve null cuando no hay VIN de 17 en el texto", () => {
    expect(vinDesdeDescripcion("Unidad GML VEHICULO Modelo:2026 No Motor:D9S0006450")).toBeNull();
  });
});

describe("tipoCostoDesdeConcepto()", () => {
  it("clasifica traslado por clave SAT y por texto", () => {
    expect(tipoCostoDesdeConcepto("78101803", "TRASLADO FRISON")).toBe("TRASLADO");
    expect(tipoCostoDesdeConcepto(null, "FLETE de la unidad")).toBe("TRASLADO");
  });
  it("clasifica accesorios y cae a OTRO por defecto (p.ej. seguro)", () => {
    expect(tipoCostoDesdeConcepto(null, "POLARIZADO y TAPETES")).toBe("ACCESORIOS");
    expect(tipoCostoDesdeConcepto("84131503", "SEGURO FRISON")).toBe("OTRO");
  });
});
