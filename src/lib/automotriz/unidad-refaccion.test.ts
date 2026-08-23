import { describe, it, expect } from "vitest";
import { factorDesdeTexto, costoEnUnidadDeVenta } from "./unidad-refaccion";

// Todas las descripciones de aquí son REALES, del catálogo de MARGOM. El
// parser existe para leerlas a ellas, no a un formato ideal.

describe("factorDesdeTexto()", () => {
  it("lee el tambo cuando la descripción lo nombra", () => {
    expect(factorDesdeTexto("SUPER GEAR GL-4 SAE 75W-90 208LT (TAMBO)", "MAUX001404", "LTR"))
      .toMatchObject({ factor: 208 });
    expect(factorDesdeTexto("LIQUIDO LIMPIA PARABRISAS- TAMBOR 208 LTS. MODELO: VARIOS", "MAUX001348", "LTR"))
      .toMatchObject({ factor: 208 });
  });

  it("lee la cubeta", () => {
    expect(factorDesdeTexto("LUBRICANTE ATF DEXRON / MERCON III CUBETA 19 LTS", "MAUX003964", "LTR"))
      .toMatchObject({ factor: 19 });
  });

  it("lee el tamaño escondido en el número de parte", () => {
    // El catálogo del proveedor mete el envase en la clave, no en el texto.
    expect(factorDesdeTexto("ACEITE LUBRICANTE DE TRANSMISION CVT", "YP-CVTF-EX1/200L", "LTR"))
      .toMatchObject({ factor: 200 });
    expect(factorDesdeTexto("Aceite CVT (Tambo)", "JAC-CVTF-EX1/200LX1", "LTR"))
      .toMatchObject({ factor: 200 });
  });

  it("lee la notación T/200 del proveedor", () => {
    expect(factorDesdeTexto("(C) ANTIFREE RAL POWER HD-21 PREM T/200", "P6070", "LTR"))
      .toMatchObject({ factor: 200 });
  });

  it("lee mililitros y los pasa a litros", () => {
    expect(factorDesdeTexto("S/P LIQ P/ FRENOS DOT-4 CJ/12 BOT 1000ML", "P11906", "LTR"))
      .toBeNull(); // 1000 ML = 1 L → factor 1, no normaliza: se descarta
  });

  it("lee el kilo cuando se vende por kilo", () => {
    expect(factorDesdeTexto("GRASA LITIO 16KG (CUBETA)", "MAUX003963", "KGM"))
      .toMatchObject({ factor: 16 });
  });

  it("NO devuelve factor cuando el tamaño está en otra unidad que la de venta", () => {
    // «16KG» no sirve para decidir el costo de un litro. Aplicarlo sería
    // inventar un número que se ve razonable y no lo es.
    expect(factorDesdeTexto("GRASA LITIO 16KG (CUBETA)", "MAUX003963", "LTR")).toBeNull();
  });

  it("NO inventa factor cuando la descripción no dice el tamaño", () => {
    // Éstas existen y son las caras: hay que capturarlas a mano.
    expect(factorDesdeTexto("PREMIUMPRO API SAE 5W-30", "MAUX003762", "LTR")).toBeNull();
    expect(factorDesdeTexto("ULTRA CLEAR PLUS CJ-4 SAE", "MAUX002948", "LTR")).toBeNull();
    expect(factorDesdeTexto("ANTICONGELANTE OAT 50", "MAUX001346", "LTR")).toBeNull();
  });

  it("descarta lecturas absurdas", () => {
    expect(factorDesdeTexto("BOMBA DE 5000 LTS POR HORA", "X", "LTR")).toBeNull();
  });

  it("no se confunde con una pieza que se vende por pieza", () => {
    expect(factorDesdeTexto("SENSOR DE POSICIÓN DEL ÁRBOL DE LEVAS", "1026070GH050", "H87")).toBeNull();
  });
});

describe("factorDesdeTexto() — descripciones del CFDI DE COMPRA", () => {
  // Éstas son las que importan. `Refaccion.descripcion` guarda la descripción
  // de VENTA («PREMIUMPRO API SAE 5W-30»), que no dice el tamaño; la línea del
  // CFDI de COMPRA sí lo dice, y es de donde hay que leerlo.
  const casos: Array<[string, number]> = [
    ["PremiumPRO API SAE 5w-30*208lt (Tambo)", 208],
    ["ACEITE AKRON PRO SP5W30 TAMBO DE 208 LTS", 208],
    ["Aceite para transmisión SAE 80W90 Tambor 208 L", 208],
    ["Anticongelante OAT 50% *208lt", 208],
    ["Anticongelante OAT 50%- Tambor 208 LTS.", 208],
    ["ATF dexron ii (Dirección hidráulica)*19lt", 19],
    ["ACEITE P/MOTOR 0W20 CAJA CON 6 LTS", 6],
  ]
  for (const [texto, esperado] of casos) {
    it(`lee ${esperado} de «${texto.slice(0, 38)}»`, () => {
      expect(factorDesdeTexto(texto, null, "LTR")).toMatchObject({ factor: esperado })
    })
  }

  it("lee la grasa por kilo cuando se vende por kilo", () => {
    expect(factorDesdeTexto("Grasa litio*16kg (Cubeta)", null, "KGM")).toMatchObject({ factor: 16 })
  })

  it("no se traga el 5W-30 ni el 0W20 como si fueran litros", () => {
    // El grado SAE trae números pegados a letras; confundirlo daría un factor
    // de 30 sobre un tambo de 208 y un costo siete veces mayor al real.
    expect(factorDesdeTexto("PremiumPRO API SAE 5w-30*208lt (Tambo)", null, "LTR")!.factor).toBe(208)
    expect(factorDesdeTexto("ACEITE SINTETICO 5W-30", null, "LTR")).toBeNull()
  })
})

describe("costoEnUnidadDeVenta()", () => {
  it("divide entre el factor cuando lo hay", () => {
    // Tambo de 208 L a $17,713 → $85.16 el litro, contra un precio de $117.
    const c = costoEnUnidadDeVenta({ ultimoCosto: 17_713, ultimoPrecio: 117, unidadCosto: "H87", unidadPrecio: "LTR", factorCosto: 208 });
    expect(c).toBeCloseTo(85.16, 1);
    expect(c!).toBeLessThan(117); // ahora sí hay margen, que es lo que existe
  });

  it("el factor manda aunque las claves del SAT se vean iguales", () => {
    // «Aceite CVT (Tambo)»: compra y venta declaradas H87 (pieza) las dos, así
    // que la clave no distingue el tambo del litro. El factor sí.
    const c = costoEnUnidadDeVenta({ ultimoCosto: 48_179, ultimoPrecio: 280, unidadCosto: "H87", unidadPrecio: "H87", factorCosto: 200 });
    expect(c).toBeCloseTo(240.9, 1);
  });

  it("sin factor y con unidades distintas, no se afirma un costo", () => {
    expect(costoEnUnidadDeVenta({ ultimoCosto: 26_693, ultimoPrecio: 214, unidadCosto: "H87", unidadPrecio: "LTR" })).toBeNull();
  });

  it("sin factor y unidades iguales, pasa la prueba de sensatez", () => {
    expect(costoEnUnidadDeVenta({ ultimoCosto: 1_200, ultimoPrecio: 1_840, unidadCosto: "H87", unidadPrecio: "H87" })).toBe(1_200);
    expect(costoEnUnidadDeVenta({ ultimoCosto: 4_308, ultimoPrecio: 1_814, unidadCosto: "H87", unidadPrecio: "H87" })).toBeNull();
  });

  it("sin costo conocido devuelve null, no cero", () => {
    // Cero diría «esta pieza no cuesta nada» y entraría al margen como utilidad
    // pura. Null dice «no se sabe», que es lo cierto.
    expect(costoEnUnidadDeVenta({ ultimoCosto: 0, ultimoPrecio: 183_142 })).toBeNull();
  });
});
