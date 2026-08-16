import { describe, it, expect } from "vitest";
import {
  datosGeneralesDesdeCfdi,
  diasCreditoDesdeCondiciones,
  emisorDesdeCfdi,
  colorDesdeTexto,
  marcaDesdeTexto,
  marcaDesdeVin,
  modeloDesdeTexto,
  numeroMotorDesdeTexto,
  tipoComprobanteDesdeCfdi,
} from "./vin";

describe("tipoComprobanteDesdeCfdi() y numeroMotorDesdeTexto()", () => {
  it("extrae el TipoDeComprobante del nodo Comprobante", () => {
    expect(tipoComprobanteDesdeCfdi(`<cfdi:Comprobante Version="4.0" TipoDeComprobante="E" Total="100">`)).toBe("E");
    expect(tipoComprobanteDesdeCfdi(`<cfdi:Comprobante Version="4.0">`)).toBeNull();
  });
  it("días de crédito desde CondicionesDePago", () => {
    expect(diasCreditoDesdeCondiciones("CRÉDITO 30 DÍAS")).toBe(30);
    expect(diasCreditoDesdeCondiciones("Credito a 15 dias fecha factura")).toBe(15);
    expect(diasCreditoDesdeCondiciones("CONTADO")).toBe(0);
    expect(diasCreditoDesdeCondiciones("Pago en una sola exhibición")).toBe(0);
    expect(diasCreditoDesdeCondiciones("TRANSFERENCIA")).toBeNull();
    expect(diasCreditoDesdeCondiciones(null)).toBeNull();
  });

  it("número de motor desde el texto libre, sin confundirlo con el VIN", () => {
    expect(numeroMotorDesdeTexto("JAC FRISON VIN: 3GALD255XTM007338 NO. MOTOR: 4GA3-1234567")).toBe("4GA3-1234567");
    expect(numeroMotorDesdeTexto("MOTOR HFC4GA3-4D12345678")).toBe("HFC4GA3-4D12345678");
    expect(numeroMotorDesdeTexto("NUM DE MOTOR 3GALD255XTM007338")).toBeNull(); // es un VIN
    expect(numeroMotorDesdeTexto("VEHICULO SIN DATO")).toBeNull();
  });
});

// Descripciones REALES de CFDIs de Margom (VIN redactado), medidas 2026-08:
// las 101 unidades POR REVISAR del piso caían en estos machotes.
describe("modeloDesdeTexto() — el modelo desde la descripción libre", () => {
  it("«MODELO X» cuando X no es un año (autobús Yutong, $9.29M c/u)", () => {
    expect(
      modeloDesdeTexto(
        "25101502  AUTOBUS MODELO ZK6126BEVGS AÑO 2026 MARCA YUTONG, PAIS ORIGEN CHINA, DIMENSION 12280*2550*4170",
      ),
    ).toBe("ZK6126BEVGS");
    expect(modeloDesdeTexto("AUTO USADO. MODELO VITARA GLX 6TA 1.6 LT MARCA SUZUKI COLOR: RASCACIELOS")).toBe(
      "VITARA GLX 6TA 1.6 LT",
    );
    expect(
      modeloDesdeTexto("MARCA: MG MOTORS MODELO: MG ZS-SUB 1.5L COM EXCITE AT AÑO: 2022 TIPO:AUTOMOVIL"),
    ).toBe("MG ZS-SUB 1.5L COM EXCITE AT");
  });

  it("el nombre pegado DESPUÉS del año («MODELO 2021 SWIFT GLX…»)", () => {
    expect(
      modeloDesdeTexto("AUTO USADO EN LAS CONDICIONES QUE SE ENCUENTRA MARCA: SUZUKI MODELO 2021 SWIFT GLX L4 IMP AUT 5 ABS, SERIE: X"),
    ).toBe("SWIFT GLX L4 IMP AUT 5 ABS");
  });

  it("«TIPO:» cuando trae el modelo, pero NO cuando es la carrocería", () => {
    expect(
      modeloDesdeTexto("AUTO USADO MARCA: CHEVROLET MODELO:2019 CILINDROS: 4 CUATRO TIPO: SPARK NG/LT A PTAS COLOR EXT:MAGENTA"),
    ).toBe("SPARK NG/LT A PTAS");
    expect(
      modeloDesdeTexto("UN AUTOMÓVIL USADO, MARCA NISSAN MODELO 2019, TIPO VERSA ADVANC E MT COLOR GRAFITO"),
    ).toBe("VERSA ADVANC E MT");
    expect(modeloDesdeTexto("Automóvil Usado Marca KIA, Tipo KIA Optima 2.0L, Turbo SXL A_T, modelo 2018")).toBe(
      "KIA OPTIMA 2.0L",
    );
  });

  it("«VERSION X» — el machote de seminuevos más común", () => {
    expect(
      modeloDesdeTexto("AUTO USADO MARCA CHEVROLET, VERSION CHEYENNE, MODELO 2018, COLOR BLANCO PLATINO"),
    ).toBe("CHEYENNE");
    expect(
      modeloDesdeTexto("AUTO USADO MARCA JAC VERSION PICK UP JAC FRISON T8 MODELO 2023 COLOR NEGRO"),
    ).toBe("PICK UP JAC FRISON T8");
  });

  it("lo que sigue a la marca, como último recurso", () => {
    expect(
      modeloDesdeTexto("UNIDAD SEMINUEVA EN LAS CONDICIONES EN LAS QUE SE ENCUENTRA: RENAULT OROCH OUTSIDER TM, MODELO: 2024, COLOR GRIS"),
    ).toBe("OROCH OUTSIDER TM");
    expect(modeloDesdeTexto("Unidad GML T6 FRISON MT DOBLE CABINA 2.0 LTS Modelo:2023 No Motor:N3010337")).toBe(
      "T6 FRISON MT DOBLE CABINA 2.0 LTS",
    );
  });

  it("null cuando no hay nada rescatable: POR REVISAR es más honesto", () => {
    expect(modeloDesdeTexto("VEHICULO SIN MAYOR DATO")).toBeNull();
    expect(modeloDesdeTexto(null)).toBeNull();
  });
});

describe("colorDesdeTexto() — el color exterior desde el machote", () => {
  it("colores simples y compuestos, con o sin etiqueta EXT", () => {
    expect(colorDesdeTexto("MODELO 2018, COLOR BLANCO PLATINO, NUMERO DE SERIE X")).toBe("BLANCO PLATINO");
    expect(colorDesdeTexto("TIPO: SPARK COLOR EXT:MAGENTA ORCHID COLOR INT: NEGRO")).toBe("MAGENTA ORCHID");
    expect(colorDesdeTexto("Color Snow White Pear, Num de Serie X")).toBe("SNOW WHITE PEAR");
    expect(colorDesdeTexto("COLOR ROJO/NEGRO")).toBe("ROJO/NEGRO");
    expect(colorDesdeTexto("COLOR: RASCACIELOS MOTOR:M16A")).toBe("RASCACIELOS");
    expect(colorDesdeTexto("COLOR PLATA ROCIO METALIZADO")).toBe("PLATA ROCIO METALIZADO");
  });

  it("corta el ruido del machote: dígitos, serie, combustible, puertas", () => {
    expect(colorDesdeTexto("COLOR GRIS 1.6 LTS 4 CIL")).toBe("GRIS");
    expect(colorDesdeTexto("COLOR NEGRO OPALO NO.DE SERIE X")).toBe("NEGRO OPALO");
    expect(colorDesdeTexto("COLOR BLANCO BRILL/NEGRO/GRIS2253811 JT")).toBe("BLANCO BRILL/NEGRO/GRIS");
    expect(colorDesdeTexto("COLOR ROJO 5 PUERTAS NO. DE SERIE X")).toBe("ROJO");
    expect(colorDesdeTexto("COLOR VINO COMBUSTIBLE GASOLINA")).toBe("VINO");
    expect(colorDesdeTexto("COLOR ROJO COMBUSTIBLE GASOLINA PEDIMENTO 2351")).toBe("ROJO");
  });

  it("null cuando no hay color en el texto", () => {
    expect(colorDesdeTexto("VEHICULO NUEVO SEI 2 SMART BY GML 5 PUERTAS")).toBeNull();
    expect(colorDesdeTexto(null)).toBeNull();
  });
});

describe("datosGeneralesDesdeCfdi() — SKU numérico y marcas nuevas", () => {
  it("un NoIdentificacion puramente numérico NO es modelo: se lee la descripción", () => {
    const g = datosGeneralesDesdeCfdi(
      "25101502  AUTOBUS MODELO ZK6126BEVGS AÑO 2026 MARCA YUTONG, PAIS ORIGEN CHINA",
      "25101502",
      2026,
    );
    expect(g).toEqual({ marca: "YUTONG", modelo: "ZK6126BEVGS", anio: 2026 });
  });

  it("un SKU con letras se respeta tal cual (comportamiento de siempre)", () => {
    const g = datosGeneralesDesdeCfdi("VEHICULO NUEVO CAMION K7", "TRACTOCAMION K7 CBU", 2024);
    expect(g.modelo).toBe("TRACTOCAMION K7 CBU");
  });

  it("GML y YUTONG ya cuentan como marca", () => {
    expect(marcaDesdeTexto("VEHICULO NUEVO SEI 2 SMART BY GML 5 PUERTAS")).toBe("GML");
    expect(marcaDesdeTexto("AUTOBUS MARCA YUTONG")).toBe("YUTONG");
    // y no le ganan a la marca del fabricante cuando ambas aparecen
    expect(marcaDesdeTexto("PICK UP JAC FRISON BY GML")).toBe("JAC");
  });

  it("la marca desde el WMI del VIN cuando el texto no la dice", () => {
    // Factura real de Giant Motors: «VEHICULO PICK UP T5 CABINA REGULAR…» —
    // ninguna marca en el texto; el VIN 3GA… es la planta de León.
    expect(marcaDesdeVin("3GALD1547TM033896")).toBe("JAC");
    expect(marcaDesdeVin("LZYTMGJW2T1002137")).toBe("YUTONG");
    expect(marcaDesdeVin("JS2ZC63S1P6402136")).toBe("SUZUKI");
    expect(marcaDesdeVin("LJ18R8CL3R3300460")).toBe("JAC");
    expect(marcaDesdeVin("WAUZZZ4M0KD018683")).toBeNull(); // WMI no curado
    expect(marcaDesdeVin("NO-ES-UN-VIN")).toBeNull();
    expect(marcaDesdeVin(null)).toBeNull();
  });

  it("seminuevo de particular sin SKU: el modelo sale del machote", () => {
    const g = datosGeneralesDesdeCfdi(
      "AUTO USADO MARCA HYUNDAI, VERSION ACCENT GL MID 1.6L 4 CIL, MODELO 2022, COLOR PLATA",
      null,
      2025,
    );
    expect(g.marca).toBe("HYUNDAI");
    expect(g.modelo).toBe("ACCENT GL MID 1.6L 4 CIL");
    expect(g.anio).toBe(2022);
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
