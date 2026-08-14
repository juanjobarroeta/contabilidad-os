import { describe, it, expect } from "vitest";
import {
  parseCatalogoCuentas,
  parseBalanza,
  balanzaASaldosApertura,
  naturalezaPorAritmetica,
  padresDeBalanza,
  tipoPorCodAgrup,
  diagnosticoApertura,
  convencionQueCuadra,
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

describe("padresDeBalanza — qué cuenta es mayor y cuál es hoja", () => {
  it("reconoce el mayor escrito con relleno de ceros (el caso de MARGOM)", () => {
    // La regla vieja partía por punto y sobre las 544 cuentas de esa balanza
    // —todas con guion— encontraba CERO padres: 103 mayores se posteaban junto
    // con sus hijas y el subárbol se duplicaba.
    const padres = padresDeBalanza([
      "1101-0000-0000",
      "1101-0101-0000",
      "1101-0102-0000",
      "1200-0000-0000",
    ]);
    expect(padres.has("1101-0000-0000")).toBe(true);
    expect(padres.has("1101-0101-0000")).toBe(false);
    // Un mayor sin hijas en la balanza es hoja: su saldo no está repetido.
    expect(padres.has("1200-0000-0000")).toBe(false);
  });

  it("sigue reconociendo la jerarquía por punto", () => {
    const padres = padresDeBalanza(["102", "102.01", "102.02", "201.01"]);
    expect([...padres]).toEqual(["102"]);
  });

  it("no confunde códigos que sólo comparten prefijo de texto", () => {
    // 1101 no es padre de 11010 — son grupos distintos, no un nivel más.
    const padres = padresDeBalanza(["1101-0000-0000", "11010-0000-0000"]);
    expect(padres.size).toBe(0);
  });

  it("maneja varios niveles", () => {
    const padres = padresDeBalanza(["6000-0000-0000", "6100-0000-0000", "6100-0001-0000"]);
    expect(padres.has("6100-0000-0000")).toBe(true);
    expect(padres.has("6000-0000-0000")).toBe(false);
  });
});

describe("naturalezaPorAritmetica — contraste, no regla primaria", () => {
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

// ─── diagnosticoApertura ─────────────────────────────────────────────────────
// El asiento de apertura de MARGOM se cae por $48,318,111.11 y postApertura
// sólo sabe decir «cargos X vs abonos Y». Esta función reparte el descuadre en
// cubetas con nombre para no tener que adivinar cuál de los candidatos es.

describe("diagnosticoApertura", () => {
  const cta = (numCta: string, saldoFin: number) => ({
    numCta, saldoIni: 0, debe: 0, haber: 0, saldoFin,
  });
  const base = {
    usar: "final" as const,
    esPadre: () => false,
    enCatalogo: () => true,
  };
  // 1 activo (D), 2 pasivo (A), 3 capital (A).
  const natPorFamilia = (c: string): "D" | "A" => (c.charAt(0) === "1" ? "D" : "A");

  it("una balanza que cuadra sale sin diferencia por los dos métodos", () => {
    const d = diagnosticoApertura({
      ...base,
      cuentas: [cta("1101", 58000), cta("2101", 28000), cta("3101", 30000)],
      naturalezaPorCodigo: natPorFamilia,
    });
    expect(d.seleccion).toEqual({ lineas: 3, cargos: 58000, abonos: 58000, diferencia: 0 });
    expect(d.conSigno.diferencia).toBe(0);
    expect(d.contrarias.cuentas).toBe(0);
  });

  it("un saldo contrario a su naturaleza descuadra por EL DOBLE con valor absoluto", () => {
    // Capital (A) con pérdidas acumuladas: saldo negativo. Con Math.abs se
    // postea como abono cuando debería ser cargo — error de 2× el saldo.
    const d = diagnosticoApertura({
      ...base,
      cuentas: [cta("1101", 58000), cta("2101", 68000), cta("3101", -10000)],
      naturalezaPorCodigo: natPorFamilia,
    });
    // Respetando el signo, la balanza cuadra: 58,000 + 10,000 = 68,000.
    expect(d.conSigno.diferencia).toBe(0);
    // Con la regla de hoy, no: el abono de 10,000 debería haber sido cargo.
    expect(d.seleccion.diferencia).toBe(-20000);
    expect(d.contrarias.cuentas).toBe(1);
    expect(d.contrarias.montoA).toBe(10000);
    expect(d.contrarias.ejemplos[0]).toEqual({ codigo: "3101", naturaleza: "A", saldo: -10000 });
  });

  it("separa el dinero que se queda fuera por cada motivo", () => {
    const d = diagnosticoApertura({
      cuentas: [cta("1101", 1000), cta("1102", 2000), cta("1103", 3000), cta("1104", 4000)],
      usar: "final",
      esPadre: (c) => c === "1102",
      enCatalogo: (c) => c !== "1103",
      naturalezaPorCodigo: (c) => (c === "1104" ? null : "D"),
    });
    expect(d.seleccion.lineas).toBe(1);
    expect(d.excluidas.porPadre).toEqual({ cuentas: 1, monto: 2000 });
    expect(d.excluidas.porCatalogo.monto).toBe(3000);
    expect(d.excluidas.porCatalogo.ejemplos).toEqual(["1103"]);
    expect(d.excluidas.porNaturaleza.monto).toBe(4000);
  });

  it("ignora los saldos en cero y agrupa por familia", () => {
    const d = diagnosticoApertura({
      ...base,
      cuentas: [cta("1101", 500), cta("1102", 0), cta("2101", 500)],
      naturalezaPorCodigo: natPorFamilia,
    });
    expect(d.seleccion.lineas).toBe(2);
    expect(d.porFamilia).toEqual([
      { familia: "1", cuentas: 1, cargos: 500, abonos: 0 },
      { familia: "2", cuentas: 1, cargos: 0, abonos: 500 },
    ]);
  });
});

// ─── convencionQueCuadra ─────────────────────────────────────────────────────
// Hay dos formas de escribir el importe en una balanza y las dos existen:
// magnitud (cada cuenta de su lado) o con el lado ya en el signo. Elegir mal no
// descuadra un poco — descuadra por el DOBLE de todo lo que corre contra su
// naturaleza. En MARGOM eso eran $48,318,111.11.

describe("convencionQueCuadra", () => {
  const cta = (numCta: string, saldoFin: number) => ({
    numCta, saldoIni: 0, debe: 0, haber: 0, saldoFin,
  });
  const natPorFamilia = (c: string): "D" | "A" => (c.charAt(0) === "1" ? "D" : "A");
  const args = (cuentas: ReturnType<typeof cta>[]) => ({
    cuentas, usar: "final" as const, naturalezaPorCodigo: natPorFamilia,
  });

  it("elige 'natural' cuando el archivo trae magnitudes", () => {
    // Activo 58,000 = Pasivo 28,000 + Capital 30,000, todo positivo.
    const r = convencionQueCuadra(args([cta("1101", 58000), cta("2101", 28000), cta("3101", 30000)]));
    expect(r.elegida).toBe("natural");
    expect(r.natural.diferencia).toBe(0);
  });

  it("reproduce el descuadre de MARGOM y lo resuelve por el signo", () => {
    // Las dos clases que el valor absoluto manda al lado equivocado: deudora
    // con saldo acreedor (sobregiro, estimación de incobrables) y acreedora con
    // saldo deudor. Los importes son los medidos en la balanza real.
    // La fixture CUADRA leída por signo — si no, no reproduce nada. El activo
    // normal sale de despejar: X = contrariaD + pasivo − contrariaA.
    const r = convencionQueCuadra(args([
      cta("1101", 25_159_055.49),
      cta("1200", -27_860_445.33),  // deudora CONTRARIA (saldo acreedor)
      cta("2101", -1_000_000),
      cta("2202", 3_701_389.84),    // acreedora CONTRARIA (saldo deudor)
    ]));
    // Con el lado por naturaleza: 2×contrariasD − 2×contrariasA.
    expect(r.natural.diferencia).toBeCloseTo(2 * 27_860_445.33 - 2 * 3_701_389.84, 2);
    expect(r.natural.diferencia).toBeCloseTo(48_318_110.98, 2);
    // Con el lado por signo, cuadra.
    expect(r.signo.diferencia).toBeCloseTo(0, 2);
    expect(r.elegida).toBe("signo");
  });

  it("devuelve elegida=null cuando el descuadre no es del signo", () => {
    // Falta capital: no hay lectura del signo que cuadre esto, y fingir que sí
    // sería inventar un asiento.
    const r = convencionQueCuadra(args([cta("1101", 58000), cta("2101", 28000)]));
    expect(r.elegida).toBeNull();
    expect(r.natural.diferencia).not.toBe(0);
    expect(r.signo.diferencia).not.toBe(0);
  });

  it("balanzaASaldosApertura sigue en 'natural' si no se le dice otra cosa", () => {
    const lineas = balanzaASaldosApertura({
      cuentas: [cta("2101", -28000)],
      usar: "final",
      naturalezaPorCodigo: natPorFamilia,
    });
    // Comportamiento histórico intacto: magnitud, lado natural.
    expect(lineas).toEqual([{ codigo: "2101", saldo: 28000 }]);
  });
});
