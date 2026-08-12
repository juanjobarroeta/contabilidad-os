import { describe, it, expect } from "vitest";
import { extraerServicioCfdi } from "./auto-servicio";

// CFDI REAL de taller de Margom (recortado a los conceptos): mano de obra
// 78181500 + refacciones con número de parte. Estructura real: conceptos con
// hijos <cfdi:Impuestos>, atributos ObjetoImp/ClaveUnidad, importes con 6
// decimales — nada de esto lo reproducían los fixtures sintéticos.
const REAL = `<?xml version="1.0" encoding="utf-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" TipoDeComprobante="I" Total="30000.00">
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="78181500" NoIdentificacion="AK1010040" Cantidad="1.000000" ClaveUnidad="HUR" Unidad="Hora" Descripcion="Mantenimiento Jac" ValorUnitario="0.010000" ObjetoImp="02" Importe="0.010000">
      <cfdi:Impuestos>
        <cfdi:Traslados>
          <cfdi:Traslado Base="0.010000" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="0.001600" />
        </cfdi:Traslados>
      </cfdi:Impuestos>
    </cfdi:Concepto>
    <cfdi:Concepto ClaveProdServ="26111600" NoIdentificacion="1025100GH055-1" Cantidad="1.000000" ClaveUnidad="H87" Unidad="Pieza" Descripcion="GENERATOR" ValorUnitario="8580.181034" ObjetoImp="02" Importe="8580.181034">
      <cfdi:Impuestos>
        <cfdi:Traslados>
          <cfdi:Traslado Base="8580.181034" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="1372.828965" />
        </cfdi:Traslados>
      </cfdi:Impuestos>
    </cfdi:Concepto>
    <cfdi:Concepto ClaveProdServ="25111500" NoIdentificacion="8103010U3446" Cantidad="1.000000" ClaveUnidad="H87" Unidad="Pieza" Descripcion="CONJUNTO DE COMPRESOR" ValorUnitario="9264.672414" ObjetoImp="02" Importe="9264.672414">
      <cfdi:Impuestos>
        <cfdi:Traslados>
          <cfdi:Traslado Base="9264.672414" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="1482.347586" />
        </cfdi:Traslados>
      </cfdi:Impuestos>
    </cfdi:Concepto>
    <cfdi:Concepto ClaveProdServ="78181500" NoIdentificacion="AK1010040" Cantidad="1.000000" ClaveUnidad="HUR" Unidad="Hora" Descripcion="Mano de obra" ValorUnitario="6896.551724" ObjetoImp="02" Importe="6896.551724">
      <cfdi:Impuestos>
        <cfdi:Traslados>
          <cfdi:Traslado Base="6896.551724" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="1103.448276" />
        </cfdi:Traslados>
      </cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
</cfdi:Comprobante>`;

// Anticipo REAL de Margom: clave 84111506 y la descripción canónica del SAT.
// La frase contiene «SERVICIO», así que el filtro de texto lo tomaba por orden
// de taller: $278,000 de enganche de una camioneta aparecían como la orden más
// cara del año en el perfil del cliente.
const ANTICIPO = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I" Total="278000.00">
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="84111506" Cantidad="1.000000" ClaveUnidad="ACT" Descripcion="ANTICIPO DEL BIEN O SERVICIO" ValorUnitario="239655.17" ObjetoImp="02" Importe="239655.17"/>
  </cfdi:Conceptos>
</cfdi:Comprobante>`;

describe("extraerServicioCfdi() — anticipos", () => {
  it("un anticipo NO es orden de taller (aunque su descripción diga SERVICIO)", () => {
    const d = extraerServicioCfdi(ANTICIPO);
    expect(d.esServicio).toBe(false);
    expect(d.manoObra).toBe(0);
  });

  it("un anticipo mezclado con mano de obra real no infla la orden", () => {
    const mixto = ANTICIPO.replace(
      "</cfdi:Conceptos>",
      `<cfdi:Concepto ClaveProdServ="78181500" Cantidad="1" Descripcion="Mano de obra" Importe="1500.00"/></cfdi:Conceptos>`
    );
    const d = extraerServicioCfdi(mixto);
    expect(d.esServicio).toBe(true);
    expect(d.manoObra).toBe(1500); // sólo la mano de obra, sin los 239,655.17
  });
});

describe("extraerServicioCfdi() sobre un CFDI REAL de taller", () => {
  it("lo reconoce como servicio y separa mano de obra de refacciones", () => {
    const d = extraerServicioCfdi(REAL);
    expect(d.esServicio).toBe(true);
    // Mano de obra: las dos líneas 78181500 (0.01 + 6,896.551724).
    expect(d.manoObra).toBeCloseTo(6896.56, 1);
    // Refacciones: las líneas con número de parte (generador + compresor).
    expect(d.refacciones).toBeCloseTo(17844.85, 1);
    expect(d.concepto).toBe("Mantenimiento Jac");
  });
});
