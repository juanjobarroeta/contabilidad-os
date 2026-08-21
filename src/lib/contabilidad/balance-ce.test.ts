import { describe, expect, it } from "vitest";
import {
  aLadoEnSigno,
  construirBalance,
  grupoDeCuenta,
  type SaldoCuenta,
} from "./balance-ce";

describe("grupoDeCuenta", () => {
  it("clasifica por el primer dígito", () => {
    expect(grupoDeCuenta("1000-0001-0000")).toBe("activo");
    expect(grupoDeCuenta("2101")).toBe("pasivo");
    expect(grupoDeCuenta("3101")).toBe("capital");
  });

  it("pliega 4–9 al resultado del ejercicio", () => {
    for (const c of ["4101", "5101", "6101", "7101", "9101"]) {
      expect(grupoDeCuenta(c)).toBe("resultado");
    }
  });

  it("descarta lo que no es cuenta de balance ni de resultado", () => {
    expect(grupoDeCuenta("")).toBeNull();
    expect(grupoDeCuenta("X100")).toBeNull();
  });
});

describe("aLadoEnSigno", () => {
  it("deja las deudoras como están y voltea las acreedoras", () => {
    expect(aLadoEnSigno(100, "D")).toBe(100);
    expect(aLadoEnSigno(100, "A")).toBe(-100);
  });

  it("respeta la naturaleza de una contra-cuenta aunque contradiga su tipo", () => {
    // «DESCUENTO NUEVOS FRISON»: tipo INGRESO pero naturaleza D. Si el lado se
    // dedujera del tipo saldría −100, y el balance se descuadraría por 200 —el
    // doble— porque el saldo se iría del lado contrario. Fue exactamente el
    // caso de MARGOM: $47,867,455 sobre 30 cuentas de descuento.
    expect(aLadoEnSigno(100, "D")).toBe(100);
    // Depreciación acumulada: tipo ACTIVO, naturaleza A.
    expect(aLadoEnSigno(100, "A")).toBe(-100);
  });
});

describe("construirBalance", () => {
  // La convención de entrada es la de la balanza CE: el LADO va en el signo.
  const declarado: SaldoCuenta[] = [
    { numCta: "1101", nombre: "Bancos", saldo: 1000 },
    { numCta: "1201", nombre: "Clientes", saldo: 500 },
    { numCta: "2101", nombre: "Proveedores", saldo: -400 },
    { numCta: "3101", nombre: "Capital social", saldo: -800 },
    { numCta: "4101", nombre: "Ventas", saldo: -900 },
    { numCta: "6101", nombre: "Gastos", saldo: 600 },
  ];

  it("entrega los saldos en signo natural, no con el lado en el signo", () => {
    const b = construirBalance(declarado, [], { presentado: true });
    const pasivo = b.grupos.find((g) => g.clave === "pasivo")!;
    // Un pasivo normal sale POSITIVO: pintarlo en negativo no le dice nada a nadie.
    expect(pasivo.declarado).toBe(400);
    expect(pasivo.cuentas[0].declarado).toBe(400);

    const activo = b.grupos.find((g) => g.clave === "activo")!;
    expect(activo.declarado).toBe(1500);
  });

  it("calcula el resultado del ejercicio como −Σ(4xxx–9xxx)", () => {
    const b = construirBalance(declarado, [], { presentado: true });
    // −(−900 + 600) = 300 de utilidad.
    expect(b.resultado.declarado).toBe(300);
  });

  it("cuadra la ecuación: activo = pasivo + capital + resultado", () => {
    const b = construirBalance(declarado, [], { presentado: true });
    expect(b.totales.activo.declarado).toBe(1500);
    expect(b.totales.pasivoCapitalResultado.declarado).toBe(1500); // 400 + 800 + 300
    expect(b.totales.descuadre.declarado).toBe(0);
  });

  it("delata el descuadre cuando la balanza declarada no cierra", () => {
    const torcida = [...declarado, { numCta: "1301", nombre: "Otro activo", saldo: 50 }];
    const b = construirBalance(torcida, [], { presentado: true });
    expect(b.totales.descuadre.declarado).toBe(50);
  });

  it("una cuenta que existe de un solo lado aparece con cero en el otro", () => {
    const derivado: SaldoCuenta[] = [{ numCta: "1101", nombre: "Bancos", saldo: 1200 }];
    const b = construirBalance(declarado, derivado, { presentado: true });
    const activo = b.grupos.find((g) => g.clave === "activo")!;
    const bancos = activo.cuentas.find((c) => c.numCta === "1101")!;
    expect(bancos.declarado).toBe(1000);
    expect(bancos.derivado).toBe(1200);
    expect(bancos.diferencia).toBe(200);

    const clientes = activo.cuentas.find((c) => c.numCta === "1201")!;
    expect(clientes.derivado).toBe(0);
    expect(clientes.diferencia).toBe(-500);
  });

  it("descarta cuentas sin saldo de ningún lado, pero conserva el grupo activo", () => {
    const b = construirBalance([{ numCta: "1101", nombre: "Bancos", saldo: 0 }], [], {
      presentado: false,
    });
    const activo = b.grupos.find((g) => g.clave === "activo");
    // El activo SIEMPRE va: un balance sin activo es un dato que falta, no un
    // balance con menos renglones.
    expect(activo).toBeDefined();
    expect(activo!.cuentas).toHaveLength(0);
    expect(b.presentado).toBe(false);
  });

  it("respeta la convención medida en MARGOM 2025-12", () => {
    // Cifras reales de la balanza presentada (agregadas por dígito):
    // activo +485,326,593.01 · pasivo −453,437,766.68 · capital −18,992,047.44
    // y resultado = −(−2,131,817,384.94 + 1,932,421,872.13 + 170,488,522.76
    //                 + 16,010,211.22) = 12,896,778.83
    const margom: SaldoCuenta[] = [
      { numCta: "1101", saldo: 485326593.01 },
      { numCta: "2101", saldo: -453437766.68 },
      { numCta: "3101", saldo: -18992047.44 },
      { numCta: "4101", saldo: -2131817384.94 },
      { numCta: "5101", saldo: 1932421872.13 },
      { numCta: "6101", saldo: 170488522.76 },
      { numCta: "9101", saldo: 16010211.22 },
    ];
    const b = construirBalance(margom, [], { presentado: true });
    expect(b.totales.activo.declarado).toBeCloseTo(485326593.01, 2);
    expect(b.resultado.declarado).toBeCloseTo(12896778.83, 2);
    // El checksum real de esa balanza es $0.06 — la foto cuadra al centavo.
    expect(Math.abs(b.totales.descuadre.declarado)).toBeLessThan(0.1);
  });
});
