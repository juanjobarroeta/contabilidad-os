import { describe, expect, it } from "vitest";
import { cotejarControles, leerControles, leerSaldos } from "./controles-estado";

// Renglones REALES de los tres estados de agosto 2026 que destaparon el bug.
const BBVA_CHEQUES = `
Saldo de Liquidación Inicial 322,417.91
Saldo de Operación Inicial 322,417.91
Depósitos / Abonos (+) 42 3,376,161.67
Retiros / Cargos (-) 126 3,620,943.87
Saldo Final (+) 77,635.71
`;
const BBVA_NOMINA = `
Depósitos / Abonos (+) 2 86,000.00
Retiros / Cargos (-) 2 79,062.20
`;
const BANORTE = `
Saldo inicial del periodo 	$ 395,814.44
+ Total de depósitos 	$ 2,140,520.31
- Total de retiros 	$ 2,484,241.80
+ Intereses Netos Ganados 	$ 0.00
`;

describe("leerControles", () => {
  it("lee conteo y total de los dos lados en BBVA", () => {
    const c = leerControles(BBVA_CHEQUES);
    expect(c.fuente).toBe("bbva");
    expect(c.depositos).toEqual({ conteo: 42, total: 3376161.67 });
    expect(c.retiros).toEqual({ conteo: 126, total: 3620943.87 });
  });

  it("lee el estado chico de nómina igual", () => {
    const c = leerControles(BBVA_NOMINA);
    expect(c.depositos?.conteo).toBe(2);
    expect(c.retiros?.total).toBe(79062.2);
  });

  // Banorte no imprime el conteo: se lee el total y se dice que no hay conteo,
  // en vez de inventar uno.
  it("lee los totales de Banorte y deja el conteo en null", () => {
    const c = leerControles(BANORTE);
    expect(c.fuente).toBe("banorte");
    expect(c.depositos).toEqual({ conteo: null, total: 2140520.31 });
    expect(c.retiros).toEqual({ conteo: null, total: 2484241.8 });
  });

  it("un banco que no reconoce no inventa controles", () => {
    const c = leerControles("Estado de cuenta\nMovimientos del periodo\n");
    expect(c.fuente).toBeNull();
    expect(c.depositos).toBeNull();
  });
});

describe("cotejarControles", () => {
  const controles = leerControles(BBVA_NOMINA);
  const completos = [
    { monto: 80000 }, { monto: 6000 },
    { monto: -70000 }, { monto: -9062.2 },
  ];

  it("cuadra cuando conteo y totales coinciden por lado", () => {
    const r = cotejarControles(controles, completos);
    expect(r.cuadra).toBe(true);
    expect(r.advertencias).toEqual([]);
    expect(r.observado.retiros).toEqual({ conteo: 2, total: 79062.2 });
  });

  it("dice cuántos movimientos faltan, no sólo que algo no cuadra", () => {
    const r = cotejarControles(controles, completos.slice(0, 3));
    expect(r.cuadra).toBe(false);
    expect(r.advertencias.join(" ")).toContain("faltan 1");
  });

  it("avisa de sobrantes: dos lotes que repiten la misma página", () => {
    const r = cotejarControles(controles, [...completos, { monto: 6000 }]);
    expect(r.advertencias.join(" ")).toContain("sobran 1");
    expect(r.advertencias.join(" ")).toContain("duplicados");
  });

  // El candado viejo (inicial + Σ ≈ final) no ve esto: un cargo leído como
  // abono deja el neto mal por el doble Y rompe los dos lados a la vez.
  it("atrapa un cargo leído como abono, que el neto solo no delata", () => {
    const conSignoMal = [
      { monto: 80000 }, { monto: 6000 },
      { monto: 70000 }, { monto: -9062.2 },
    ];
    const r = cotejarControles(controles, conSignoMal);
    expect(r.cuadra).toBe(false);
    const texto = r.advertencias.join(" ");
    expect(texto).toContain("depósitos");
    expect(texto).toContain("retiros");
  });

  // Sin controles legibles la respuesta honesta es «no hubo con qué cotejar»,
  // que NO es lo mismo que «cuadró».
  it("devuelve null cuando el banco no imprimió controles", () => {
    const r = cotejarControles(leerControles("nada"), completos);
    expect(r.cuadra).toBeNull();
    expect(r.advertencias).toEqual([]);
  });
});

// El estado de Santander imprime las ETIQUETAS en un bloque y los IMPORTES en
// otro. Con `\s` —que incluye el salto de línea— «= Saldo final» se ataba al
// primer número del bloque de importes, que es el saldo INICIAL. Resultado en
// CENTRO, agosto 2026: el candado acusó un descuadre de $65,412.95 sobre una
// extracción correcta, y proponía guardar el saldo equivocado como ancla del mes.
describe("leerSaldos() — etiquetas y números en bloques distintos", () => {
  const SANTANDER = [
    "Resumen saldos.",
    "Saldo promedio",
    "No requiere saldo promedio mínimo",
    "Saldo inicial",
    "+Depósitos",
    "- Retiros",
    "= Saldo final",
    "71,372.36",
    "17,695.87",
    "65,412.95",
    "5,959.41",
    "Saldo inicial de $71,372.36",
    "Saldo final $5,959.41",
    "SALDO FINAL DEL PERIODO ANTERIOR: $71,372.36",
  ].join("\n");

  it("toma los saldos de su propio renglón, no del bloque de al lado", () => {
    expect(leerSaldos(SANTANDER)).toEqual({ inicial: 71372.36, final: 5959.41 });
  });

  it("«saldo final del periodo anterior» no es el saldo final", () => {
    expect(leerSaldos("SALDO FINAL DEL PERIODO ANTERIOR: $71,372.36").final).toBeNull();
  });

  // Los formatos que ya funcionaban siguen igual.
  it("BBVA y Banorte no se rompen", () => {
    expect(leerSaldos("Saldo de Liquidación Inicial 322,417.91\nSaldo Final (+) 77,635.71")).toEqual({
      inicial: 322417.91,
      final: 77635.71,
    });
    expect(leerSaldos("Saldo inicial del periodo \t$ 395,814.44\nSaldo actual \t$ 9,766.31")).toEqual({
      inicial: 395814.44,
      final: 9766.31,
    });
  });
});
