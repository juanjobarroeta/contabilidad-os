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
