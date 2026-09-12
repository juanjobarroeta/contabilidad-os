import { describe, expect, it } from "vitest";
import {
  cuentaBancariaEnListado,
  nivelDeCodigo,
  parseListadoCuentas,
  resolverAgrupador,
  type CuentaListado,
} from "./catalogo-listado";
import { esAgrupadorOficial } from "./agrupador";

const cuenta = (p: Partial<CuentaListado> & { codigo: string; agrupador: string }): CuentaListado => ({
  nombre: "x",
  naturaleza: "D",
  esDeMayor: false,
  nivel: 2,
  ...p,
});

describe("resolverAgrupador", () => {
  it("el nombre solo, cuando es único en el Anexo 24", () => {
    const r = resolverAgrupador(cuenta({ codigo: "102001001", agrupador: "Bancos nacionales" }));
    expect(r).toMatchObject({ codAgrup: "102.01", via: "nombre-unico" });
  });

  // Las cinco cajas del hospital declaran el mismo agrupador. Las cinco son
  // 101.01: el número de en medio es suyo, no del SAT.
  it.each([
    ["101001000", "Tesorería"],
    ["101002000", "Caja Admisiones"],
    ["101003000", "Caja Cafetería"],
    ["101004000", "Caja Farmacia Externa"],
    ["101005000", "Caja General"],
  ])("%s (%s) es 101.01, no 101.0x", (codigo, nombre) => {
    expect(resolverAgrupador(cuenta({ codigo, nombre, agrupador: "Caja y efectivo" })).codAgrup).toBe("101.01");
  });

  it("desempata por el mayor cuando el nombre vive en varias ramas", () => {
    // «Derechos fiduciarios» es 109.22, 203.17 y 253.17. Su cuenta empieza en 109.
    const r = resolverAgrupador(cuenta({ codigo: "109022000", agrupador: "Derechos fiduciarios" }));
    expect(r).toMatchObject({ codAgrup: "109.22", via: "por-mayor" });
  });

  it("entre padre e hijo del mismo nombre, manda si es cuenta de título", () => {
    // «Subsidio al empleo por aplicar» es 110 y 110.01.
    expect(
      resolverAgrupador(cuenta({ codigo: "110000000", agrupador: "Subsidio al empleo por aplicar", esDeMayor: true })),
    ).toMatchObject({ codAgrup: "110", via: "padre" });
    expect(
      resolverAgrupador(cuenta({ codigo: "110001000", agrupador: "Subsidio al empleo por aplicar", esDeMayor: false })),
    ).toMatchObject({ codAgrup: "110.01", via: "hijo" });
  });

  it("sin agrupador declarado no inventa uno", () => {
    expect(resolverAgrupador(cuenta({ codigo: "100000000", agrupador: "" }))).toMatchObject({
      codAgrup: null,
      via: "sin-agrupador",
    });
  });

  it("un nombre que no está en el Anexo 24 se queda sin código", () => {
    expect(resolverAgrupador(cuenta({ codigo: "168000000", agrupador: "Maquinaria de fuentes renovables" }))).toMatchObject({
      codAgrup: null,
      via: "nombre-desconocido",
    });
  });

  // LO QUE NO SE PUEDE ROMPER. Un código que el SAT no reconoce hace que
  // rechace la Contabilidad Electrónica completa.
  it("nunca devuelve un código que el SAT no acepte", () => {
    const casos: CuentaListado[] = [
      cuenta({ codigo: "101001000", agrupador: "Caja y efectivo" }),
      cuenta({ codigo: "102002001", agrupador: "Bancos nacionales" }),
      cuenta({ codigo: "105002003", agrupador: "Clientes nacionales" }),
      cuenta({ codigo: "601048000", agrupador: "Combustibles y lubricantes" }),
      cuenta({ codigo: "115000000", agrupador: "Almacenes", esDeMayor: true }),
      cuenta({ codigo: "605000000", agrupador: "Mano de obra directa", esDeMayor: true }),
      cuenta({ codigo: "403001000", agrupador: "Otros ingresos" }),
    ];
    for (const c of casos) {
      const { codAgrup } = resolverAgrupador(c);
      if (codAgrup !== null) expect(esAgrupadorOficial(codAgrup), `${c.codigo} → ${codAgrup}`).toBe(true);
    }
  });
});

describe("nivelDeCodigo", () => {
  it.each([
    ["101000000", 1],
    ["101001000", 2],
    ["101001001", 3],
    ["102001002", 3],
  ])("%s es nivel %i", (codigo, nivel) => {
    expect(nivelDeCodigo(codigo)).toBe(nivel);
  });
});

describe("parseListadoCuentas", () => {
  // El preámbulo cambia de largo según los filtros con que se exportó, así que
  // el parser busca el encabezado en vez de saltar un número fijo de filas.
  const hoja: unknown[][] = [
    ["Hoja:", 1],
    ["Listado de Cuentas", "", "", "", "", "Fecha 11/09/2026"],
    ["Columna", "Filtro"],
    ["Cuenta", "Todos"],
    ["Moneda", "Todos"],
    ["Cuenta", "Nombre de cuenta", "Tipo", "Cuenta de mayor", "Moneda", "Agrupador del SAT"],
    ["101000000", "Caja ", "Activo Deudora ", "Si ", "Peso Mexicano ", "Caja "],
    ["101001000", "Tesorería ", "Activo Deudora ", "No ", "Peso Mexicano ", "Caja y efectivo "],
    ["201001000", "Proveedores ", "Pasivo Acreedora ", "De Título ", "Peso Mexicano ", "Proveedores nacionales "],
    ["", "", "", "", "", ""],
  ];

  it("encuentra el encabezado y limpia los espacios de la exportación", () => {
    const cuentas = parseListadoCuentas(hoja);
    expect(cuentas).toHaveLength(3);
    expect(cuentas[1]).toEqual({
      codigo: "101001000",
      nombre: "Tesorería",
      naturaleza: "D",
      esDeMayor: false,
      agrupador: "Caja y efectivo",
      nivel: 2,
    });
  });

  it("lee la naturaleza del tipo y trata «De Título» como cuenta de mayor", () => {
    const cuentas = parseListadoCuentas(hoja);
    expect(cuentas[2].naturaleza).toBe("A");
    expect(cuentas[2].esDeMayor).toBe(true);
    expect(cuentas[0].esDeMayor).toBe(true);
  });

  it("una hoja sin encabezado no devuelve basura", () => {
    expect(parseListadoCuentas([["otra", "cosa"]])).toEqual([]);
  });
});

describe("cuentaBancariaEnListado", () => {
  const cuentas = [
    { codigo: "102001001", nombre: "Bancomer Cta 0120809012", codAgrup: "102.01" },
    { codigo: "102001002", nombre: "Bancomer Cta 0122355205", codAgrup: "102.01" },
    { codigo: "102001003", nombre: "Banorte Cta 1358620258", codAgrup: "102.01" },
    { codigo: "102005002", nombre: "Banco Santander", codAgrup: "102.01" },
    { codigo: "105002001", nombre: "Paciente 0120809012", codAgrup: "105.01" },
  ];

  it("empata por el número completo dentro del nombre", () => {
    expect(cuentaBancariaEnListado("0120809012", cuentas)?.codigo).toBe("102001001");
    expect(cuentaBancariaEnListado("0122355205", cuentas)?.codigo).toBe("102001002");
  });

  // Dos cuentas Bancomer: el nombre del banco no distingue, el número sí.
  it("no se confunde entre dos cuentas del mismo banco", () => {
    expect(cuentaBancariaEnListado("0122355205", cuentas)?.nombre).toBe("Bancomer Cta 0122355205");
  });

  it("una cuenta sin el número en el nombre se queda sin empatar", () => {
    expect(cuentaBancariaEnListado("65510901314", cuentas)).toBeNull();
  });

  // Un auxiliar de cliente puede llevar un número parecido; sólo cuenta si está
  // bajo el agrupador de bancos.
  it("sólo mira cuentas de bancos", () => {
    const soloCliente = cuentas.filter((c) => c.codAgrup === "105.01");
    expect(cuentaBancariaEnListado("0120809012", soloCliente)).toBeNull();
  });

  it("no empata por los últimos dígitos", () => {
    expect(cuentaBancariaEnListado("9012", cuentas)).toBeNull();
  });
});
