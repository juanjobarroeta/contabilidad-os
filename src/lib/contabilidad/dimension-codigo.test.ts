import { describe, it, expect } from "vitest";
import { COE_CODES } from "./catalog";
import { DIMENSION_POR_CODIGO, dimensionDe, esDecisionDePersona } from "./dimension-codigo";

// ─────────────────────────────────────────────────────────────────────────────
// El caso que originó esto: BAOBAB JQM no podía cerrar y la cola le pedía ocho
// decisiones. SEIS no tenían respuesta — su catálogo lleva un auxiliar por
// contraparte (31 proveedores, 5 clientes, 8 acreedores) y elegir uno manda el
// saldo de todos a la elegida. Sólo dos eran preguntas reales.
// ─────────────────────────────────────────────────────────────────────────────

describe("dimensionDe()", () => {
  it("lo que se resuelve por contraparte no es decisión de nadie", () => {
    for (const c of [
      COE_CODES.BANCOS,
      COE_CODES.CLIENTES_NACIONALES,
      COE_CODES.PROVEEDORES,
      COE_CODES.DEUDORES_DIVERSOS,
      COE_CODES.ACREEDORES_DIVERSOS,
      COE_CODES.ANTICIPOS_CLIENTES,
      COE_CODES.ANTICIPOS_PROVEEDORES,
      COE_CODES.PRESTAMOS_OTORGADOS,
      COE_CODES.PRESTAMOS_RECIBIDOS,
    ]) {
      expect(dimensionDe(c).dimension).toBe("CONTRAPARTE");
      expect(esDecisionDePersona(c)).toBe(false);
    }
  });

  it("cada código por contraparte dice de qué padrón sale", () => {
    expect(dimensionDe(COE_CODES.BANCOS).padron).toBe("BANCO");
    expect(dimensionDe(COE_CODES.CLIENTES_NACIONALES).padron).toBe("CLIENTE");
    expect(dimensionDe(COE_CODES.PROVEEDORES).padron).toBe("PROVEEDOR");
    expect(dimensionDe(COE_CODES.PRESTAMOS_RECIBIDOS).padron).toBe("RELACIONADA");
  });

  it("la utilidad de ejercicios anteriores la elige el AÑO", () => {
    // BAOBAB tiene RESULTADO EJERCICIO 2021, 2022 y 2024. Ninguna es «la» buena.
    expect(dimensionDe(COE_CODES.RESULTADOS_ACUMULADOS).dimension).toBe("EJERCICIO");
    expect(esDecisionDePersona(COE_CODES.RESULTADOS_ACUMULADOS)).toBe(false);
  });

  it("las dos preguntas de BAOBAB que SÍ eran reales siguen siéndolo", () => {
    // 401.01: ¿ventas al 16% o ingresos por arrendamiento?
    // 701.10: ¿comisiones bancarias o comisión por apertura de créditos?
    expect(esDecisionDePersona(COE_CODES.VENTAS_GENERAL)).toBe(true);
    expect(esDecisionDePersona(COE_CODES.COMISIONES_BANCARIAS)).toBe(true);
  });

  it("lo no listado es FIJO: el default no inventa dimensiones", () => {
    expect(dimensionDe(COE_CODES.IVA_POR_PAGAR).dimension).toBe("FIJA");
    expect(dimensionDe(COE_CODES.CAJA).dimension).toBe("FIJA");
    expect(dimensionDe("999.99").dimension).toBe("FIJA");
  });

  it("todo código dimensional es uno de los que el motor usa", () => {
    // Una entrada con un código que el motor no emite no se ejecuta nunca y
    // envejece en silencio.
    const delMotor = new Set<string>(Object.values(COE_CODES));
    for (const c of Object.keys(DIMENSION_POR_CODIGO)) expect(delMotor.has(c)).toBe(true);
  });

  it("todo código por contraparte declara su padrón", () => {
    for (const [codigo, d] of Object.entries(DIMENSION_POR_CODIGO)) {
      if (d.dimension === "CONTRAPARTE") expect(d.padron, codigo).toBeTruthy();
    }
  });

  it("cada uno trae su porqué, que es lo que lee quien cierra", () => {
    for (const [codigo, d] of Object.entries(DIMENSION_POR_CODIGO)) {
      expect(d.porque.length, codigo).toBeGreaterThan(20);
    }
  });
});
