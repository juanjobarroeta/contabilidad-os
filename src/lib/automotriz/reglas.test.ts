import { describe, it, expect } from "vitest";
import { aplicarReglas, compilarPatron, prepararReglas, validarRegla, MAX_PATRON, type ReglaAplicable } from "./reglas";

const regla = (o: Partial<ReglaAplicable> = {}): ReglaAplicable => ({
  id: "r1", ambito: "INGRESO", clavePrefijo: null, patron: null,
  destino: "otros_ingresos", etiqueta: "Otros ingresos", ...o,
});

describe("validarRegla()", () => {
  it("rechaza la regla sin criterios: empataría con el archivo entero", () => {
    // Una regla así no explica el residuo, lo borra — lo contrario de para qué
    // existe el reporte.
    expect(validarRegla({ ambito: "INGRESO", destino: "otros_ingresos", etiqueta: "X" }))
      .toMatch(/al menos un criterio/i);
  });

  it("acepta una regla con sólo prefijo, o con sólo patrón", () => {
    expect(validarRegla({ ambito: "INGRESO", clavePrefijo: "8014", destino: "otros_ingresos", etiqueta: "X" })).toBeNull();
    expect(validarRegla({ ambito: "EGRESO", patron: "SEGURO", destino: "601.57", etiqueta: "X" })).toBeNull();
  });

  it("rechaza prefijos que no son claves del SAT", () => {
    expect(validarRegla({ ambito: "INGRESO", clavePrefijo: "80AB", destino: "d", etiqueta: "X" })).toMatch(/prefijo/i);
    expect(validarRegla({ ambito: "INGRESO", clavePrefijo: "8", destino: "d", etiqueta: "X" })).toMatch(/prefijo/i);
  });

  it("rechaza el patrón que no compila y el kilométrico", () => {
    expect(validarRegla({ ambito: "INGRESO", patron: "((((", destino: "d", etiqueta: "X" })).toMatch(/regular/i);
    expect(validarRegla({ ambito: "INGRESO", patron: "a".repeat(MAX_PATRON + 1), destino: "d", etiqueta: "X" }))
      .toMatch(/exceder/i);
  });

  it("exige un ámbito conocido y una etiqueta legible", () => {
    expect(validarRegla({ ambito: "LO_QUE_SEA", clavePrefijo: "80", destino: "d", etiqueta: "X" })).toMatch(/ámbito/i);
    expect(validarRegla({ ambito: "INGRESO", clavePrefijo: "80", destino: "d", etiqueta: "  " })).toMatch(/etiqueta/i);
  });
});

describe("compilarPatron()", () => {
  it("compila insensible a mayúsculas", () => {
    expect(compilarPatron("bono")!.test("BONO FLOTILLAS")).toBe(true);
  });
  it("devuelve null en vez de lanzar", () => {
    expect(compilarPatron("((((")).toBeNull();
    expect(compilarPatron(null)).toBeNull();
  });
});

describe("prepararReglas() / aplicarReglas()", () => {
  const concepto = { tipo: "INGRESO", clave: "80141600", descripcion: "BONO FLOTILLAS ABRIL" };

  it("gana la más específica, capturada en cualquier orden", () => {
    const generica = regla({ id: "g", clavePrefijo: "80", etiqueta: "Genérica" });
    const especifica = regla({ id: "e", clavePrefijo: "80141600", patron: "BONO", etiqueta: "Específica" });
    expect(aplicarReglas(prepararReglas([generica, especifica]), concepto)!.id).toBe("e");
    expect(aplicarReglas(prepararReglas([especifica, generica]), concepto)!.id).toBe("e");
  });

  it("no cruza ámbitos: una regla de ingreso no clasifica un egreso", () => {
    const reglas = prepararReglas([regla({ clavePrefijo: "8014" })]);
    expect(aplicarReglas(reglas, { ...concepto, tipo: "EGRESO" })).toBeNull();
  });

  it("exige que se cumplan TODOS los criterios de la regla, no cualquiera", () => {
    const reglas = prepararReglas([regla({ clavePrefijo: "8014", patron: "UDI" })]);
    // La clave empata pero la descripción no: no aplica.
    expect(aplicarReglas(reglas, concepto)).toBeNull();
    expect(aplicarReglas(reglas, { ...concepto, descripcion: "UDI GNP MARZO" })).not.toBeNull();
  });

  it("descarta la regla con patrón roto en vez de dejarla empatar por clave", () => {
    // El modo de fallar de una regla rota tiene que ser NO aplicar: si
    // sobreviviera sin su regex, clasificaría todo lo de esa clave.
    const reglas = prepararReglas([regla({ clavePrefijo: "8014", patron: "((((" })]);
    expect(reglas).toHaveLength(0);
    expect(aplicarReglas(reglas, concepto)).toBeNull();
  });

  it("separa el bono del UDI, que es para lo que existe todo esto", () => {
    // Los dos viven bajo la MISMA clave 80141600 y el catálogo del SAT no los
    // distingue: uno se gana vendiendo coches, el otro colocando pólizas.
    const reglas = prepararReglas([
      regla({ id: "bono", clavePrefijo: "80141600", patron: "BONO", destino: "otros_ingresos", etiqueta: "Bonos" }),
      regla({ id: "udi", clavePrefijo: "80141600", patron: "\\bUDIS?\\b", destino: "gasto", etiqueta: "Comisiones de seguros" }),
    ]);
    expect(aplicarReglas(reglas, concepto)!.id).toBe("bono");
    expect(aplicarReglas(reglas, { ...concepto, descripcion: "UDI QUALITAS ABRIL" })!.id).toBe("udi");
  });
});
