import { describe, it, expect } from "vitest";
import {
  parseCatalogoCuentas,
  parseBalanza,
  balanzaASaldosApertura,
  naturalezaPorAritmetica,
  tipoPorCodAgrup,
} from "./ce-import";

const CATALOGO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<catalogocuentas:Catalogo xmlns:catalogocuentas="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas" Version="1.3" RFC="AAA010101AAA" Mes="01" Anio="2026">
  <catalogocuentas:Ctas CodAgrup="102" NumCta="102" Desc="Bancos" Nivel="1" Natur="D"/>
  <catalogocuentas:Ctas CodAgrup="102.01" NumCta="102.01" Desc="Bancos nacionales M.N." Nivel="2" Natur="D"/>
  <catalogocuentas:Ctas CodAgrup="201" NumCta="201.01" Desc="Proveedores &amp; Cía" Nivel="2" Natur="A"/>
  <catalogocuentas:Ctas CodAgrup="301" NumCta="301.01" Desc="Capital social" Nivel="2" Natur="A"/>
</catalogocuentas:Catalogo>`;

const BALANZA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<BCE:Balanza xmlns:BCE="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" Version="1.3" RFC="AAA010101AAA" Mes="12" Anio="2025" TipoEnvio="N">
  <BCE:Ctas NumCta="102.01" SaldoIni="50000.00" Debe="10000.00" Haber="2000.00" SaldoFin="58000.00"/>
  <BCE:Ctas NumCta="201.01" SaldoIni="20000.00" Debe="0.00" Haber="8000.00" SaldoFin="28000.00"/>
  <BCE:Ctas NumCta="301.01" SaldoIni="30000.00" Debe="0.00" Haber="0.00" SaldoFin="30000.00"/>
</BCE:Balanza>`;

describe("tipoPorCodAgrup — primer dígito del código agrupador SAT", () => {
  it("clasifica por familia", () => {
    expect(tipoPorCodAgrup("102")).toBe("ACTIVO");
    expect(tipoPorCodAgrup("201.01")).toBe("PASIVO");
    expect(tipoPorCodAgrup("301")).toBe("CAPITAL");
    expect(tipoPorCodAgrup("401.01")).toBe("INGRESO");
    expect(tipoPorCodAgrup("501")).toBe("COSTO");
    expect(tipoPorCodAgrup("601.01")).toBe("GASTO");
    expect(tipoPorCodAgrup("704")).toBe("GASTO");
  });
});

describe("naturalezaPorAritmetica — la balanza se delata sola", () => {
  it("deduce deudora cuando el movimiento sólo cuadra sumando el Debe", () => {
    // 50,000 + 10,000 − 2,000 = 58,000 (la identidad acreedora daría 42,000).
    expect(naturalezaPorAritmetica({ saldoIni: 50000, debe: 10000, haber: 2000, saldoFin: 58000 })).toBe("D");
  });

  it("deduce acreedora cuando sólo cuadra sumando el Haber", () => {
    expect(naturalezaPorAritmetica({ saldoIni: 20000, debe: 0, haber: 8000, saldoFin: 28000 })).toBe("A");
  });

  it("no deduce nada sin movimiento: las dos identidades cuadran", () => {
    // Es el caso de MARGOM que importa: una cuenta con saldo y sin movimientos
    // del mes NO dice de qué lado está. Devolver "D" aquí llamaría deudora a
    // toda cuenta inactiva.
    expect(naturalezaPorAritmetica({ saldoIni: 30000, debe: 0, haber: 0, saldoFin: 30000 })).toBeNull();
  });

  it("no deduce nada cuando Debe = Haber aunque haya movimiento", () => {
    expect(naturalezaPorAritmetica({ saldoIni: 100, debe: 500, haber: 500, saldoFin: 100 })).toBeNull();
  });

  it("no inventa cuando el renglón no es consistente por ningún lado", () => {
    expect(naturalezaPorAritmetica({ saldoIni: 1000, debe: 300, haber: 100, saldoFin: 5000 })).toBeNull();
  });

  it("tolera el redondeo de centavos del XML", () => {
    expect(naturalezaPorAritmetica({ saldoIni: 1000, debe: 300, haber: 100, saldoFin: 1200.004 })).toBe("D");
  });

  it("clasifica una contra-cuenta de activo por su aritmética, no por su primer dígito", () => {
    // Depreciación acumulada (1240-0000-0000): código de activo, naturaleza
    // ACREEDORA. Es exactamente la familia que la regla del primer dígito
    // reprueba — 128 cuentas medidas en producción.
    expect(naturalezaPorAritmetica({ saldoIni: 800000, debe: 0, haber: 45000, saldoFin: 845000 })).toBe("A");
  });

  it("lee la naturaleza de cada renglón de una balanza real parseada", () => {
    const bal = parseBalanza(BALANZA_XML);
    expect(bal.cuentas.map((c) => naturalezaPorAritmetica(c))).toEqual(["D", "A", null]);
  });
});

describe("parseCatalogoCuentas — Anexo 24 (catalogocuentas)", () => {
  it("extrae RFC y todas las cuentas con sus atributos", () => {
    const r = parseCatalogoCuentas(CATALOGO_XML);
    expect(r.rfc).toBe("AAA010101AAA");
    expect(r.cuentas).toHaveLength(4);

    expect(r.cuentas[0]).toEqual({
      codAgrup: "102",
      numCta: "102",
      desc: "Bancos",
      nivel: 1,
      natur: "D",
    });
    // Sub-cuenta con punto y nivel 2.
    expect(r.cuentas[1]).toMatchObject({ codAgrup: "102.01", numCta: "102.01", nivel: 2, natur: "D" });
    // Naturaleza acreedora y des-escape de entidades XML.
    expect(r.cuentas[2]).toMatchObject({ numCta: "201.01", natur: "A", desc: "Proveedores & Cía" });
  });

  it("omite nodos sin CodAgrup o sin naturaleza válida", () => {
    const xml = `<Catalogo RFC="X">
      <Ctas CodAgrup="102" NumCta="102" Desc="Bancos" Nivel="1" Natur="D"/>
      <Ctas NumCta="999" Desc="sin codagrup" Nivel="1" Natur="D"/>
      <Ctas CodAgrup="500" NumCta="500" Desc="sin natur" Nivel="1"/>
    </Catalogo>`;
    const r = parseCatalogoCuentas(xml);
    expect(r.cuentas).toHaveLength(1);
    expect(r.cuentas[0].codAgrup).toBe("102");
  });
});

describe("parseBalanza — Anexo 24 (BCE)", () => {
  it("extrae RFC, periodo y los importes por cuenta", () => {
    const r = parseBalanza(BALANZA_XML);
    expect(r.rfc).toBe("AAA010101AAA");
    expect(r.anio).toBe(2025);
    expect(r.mes).toBe(12);
    expect(r.cuentas).toHaveLength(3);
    expect(r.cuentas[0]).toEqual({
      numCta: "102.01",
      saldoIni: 50000,
      debe: 10000,
      haber: 2000,
      saldoFin: 58000,
    });
  });
});

describe("balanzaASaldosApertura — balanza → líneas {codigo, saldo}", () => {
  const { cuentas } = parseBalanza(BALANZA_XML);
  const natur = (c: string): "D" | "A" | null =>
    c.startsWith("1") ? "D" : c.startsWith("2") || c.startsWith("3") ? "A" : null;

  it("usa SaldoFin (apertura del periodo siguiente) por defecto", () => {
    const lineas = balanzaASaldosApertura({
      cuentas,
      usar: "final",
      naturalezaPorCodigo: natur,
    });
    expect(lineas).toEqual([
      { codigo: "102.01", saldo: 58000 },
      { codigo: "201.01", saldo: 28000 },
      { codigo: "301.01", saldo: 30000 },
    ]);
    // Activo 58k = Pasivo 28k + Capital 30k → la apertura cuadra.
    const activos = lineas.filter((l) => natur(l.codigo) === "D").reduce((s, l) => s + l.saldo, 0);
    const pasivoCapital = lineas.filter((l) => natur(l.codigo) === "A").reduce((s, l) => s + l.saldo, 0);
    expect(activos).toBe(pasivoCapital);
  });

  // La balanza del SAT trae el mayor Y sus subcuentas, y el saldo del mayor YA
  // es la suma de las hijas. Postear ambos duplica el subárbol: es lo que dejó
  // la apertura de MARGOM descuadrada por $40,990,542.86. El filtro de detalle
  // vive en el llamador (ce-import-apply) y esto fija el contrato que asume.
  it("con mayor + subcuentas, sólo las HOJAS cuadran la apertura", () => {
    const conMayores = [
      { numCta: "102", saldoIni: 0, debe: 0, haber: 0, saldoFin: 58000 }, // mayor = suma
      { numCta: "102.01", saldoIni: 0, debe: 0, haber: 0, saldoFin: 50000 },
      { numCta: "102.02", saldoIni: 0, debe: 0, haber: 0, saldoFin: 8000 },
      { numCta: "201.01", saldoIni: 0, debe: 0, haber: 0, saldoFin: 28000 },
      { numCta: "301.01", saldoIni: 0, debe: 0, haber: 0, saldoFin: 30000 },
    ];
    const esPadre = new Set<string>();
    for (const c of conMayores) {
      const p = c.numCta.split(".");
      for (let i = 1; i < p.length; i++) esPadre.add(p.slice(0, i).join("."));
    }

    const sinFiltro = balanzaASaldosApertura({ cuentas: conMayores, usar: "final", naturalezaPorCodigo: natur });
    const sum = (ls: { codigo: string; saldo: number }[], n: "D" | "A") =>
      ls.filter((l) => natur(l.codigo) === n).reduce((s, l) => s + l.saldo, 0);
    // Sin filtro el activo se cuenta dos veces: 58k del mayor + 58k de las hijas.
    expect(sum(sinFiltro, "D")).toBe(116000);
    expect(sum(sinFiltro, "D")).not.toBe(sum(sinFiltro, "A"));

    const soloHojas = balanzaASaldosApertura({
      cuentas: conMayores,
      usar: "final",
      naturalezaPorCodigo: natur,
      incluir: (numCta) => !esPadre.has(numCta),
    });
    expect(soloHojas.map((l) => l.codigo)).toEqual(["102.01", "102.02", "201.01", "301.01"]);
    expect(sum(soloHojas, "D")).toBe(58000);
    expect(sum(soloHojas, "D")).toBe(sum(soloHojas, "A")); // ahora sí cuadra
  });

  it("usa SaldoIni cuando se pide 'inicial'", () => {
    const lineas = balanzaASaldosApertura({ cuentas, usar: "inicial", naturalezaPorCodigo: natur });
    expect(lineas).toContainEqual({ codigo: "102.01", saldo: 50000 });
  });

  it("omite cuentas sin naturaleza conocida y con saldo ~0", () => {
    const lineas = balanzaASaldosApertura({
      cuentas: [
        { numCta: "102.01", saldoIni: 0, debe: 0, haber: 0, saldoFin: 100 },
        { numCta: "999.99", saldoIni: 0, debe: 0, haber: 0, saldoFin: 500 }, // sin naturaleza
        { numCta: "201.01", saldoIni: 0, debe: 0, haber: 0, saldoFin: 0 }, // saldo ~0
      ],
      usar: "final",
      naturalezaPorCodigo: natur,
    });
    expect(lineas).toEqual([{ codigo: "102.01", saldo: 100 }]);
  });

  it("respeta el filtro `incluir`", () => {
    const lineas = balanzaASaldosApertura({
      cuentas,
      usar: "final",
      naturalezaPorCodigo: natur,
      incluir: (c) => c === "102.01",
    });
    expect(lineas).toEqual([{ codigo: "102.01", saldo: 58000 }]);
  });
});
