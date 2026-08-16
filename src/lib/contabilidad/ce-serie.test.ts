import { describe, it, expect } from "vitest";
import { balanzaASerie } from "./ce-serie";

// Forma real (AMA170817NK1): la balanza trae el MAYOR y sus hijas — el saldo
// del mayor YA es la suma. esPadre existe para que nadie vuelva a sumar los
// $1.9 mil millones.
const BALANZA_XML = `<?xml version="1.0" encoding="utf-8"?>
<BCE:Balanza xmlns:BCE="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" Version="1.3" RFC="AMA170817NK1" Mes="6" Anio="2026" TipoEnvio="N">
  <BCE:Ctas NumCta="1301-0000-0000" SaldoIni="150000000" Debe="10000000" Haber="20000000" SaldoFin="140000000"/>
  <BCE:Ctas NumCta="1301-0004-0000" SaldoIni="40000000" Debe="7000000" Haber="6000000" SaldoFin="41000000"/>
  <BCE:Ctas NumCta="1301-0028-0000" SaldoIni="7000000" Debe="0" Haber="16812.80" SaldoFin="6983187.20"/>
</BCE:Balanza>`;

describe("balanzaASerie() — XML presentado → filas de la serie", () => {
  it("período, importes tal cual, y esPadre para el mayor", () => {
    const s = balanzaASerie(BALANZA_XML);
    expect(s).not.toBeNull();
    expect({ anio: s!.anio, mes: s!.mes }).toEqual({ anio: 2026, mes: 6 });
    expect(s!.filas).toHaveLength(3);

    const mayor = s!.filas.find((f) => f.numCta === "1301-0000-0000")!;
    expect(mayor.esPadre).toBe(true);
    expect(mayor.saldoFin).toBe(140000000);

    const traveler = s!.filas.find((f) => f.numCta === "1301-0028-0000")!;
    expect(traveler.esPadre).toBe(false);
    expect(traveler).toMatchObject({ saldoIni: 7000000, debe: 0, haber: 16812.8, saldoFin: 6983187.2 });
  });

  it("las hojas suman lo del mayor: quien reporte debe filtrar esPadre", () => {
    const s = balanzaASerie(BALANZA_XML)!;
    const hojas = s.filas.filter((f) => !f.esPadre);
    expect(hojas.map((f) => f.numCta).sort()).toEqual(["1301-0004-0000", "1301-0028-0000"]);
  });

  it("null si el XML no trae período (no se inventa un mes)", () => {
    const sinMes = BALANZA_XML.replace(' Mes="6"', "").replace(' Anio="2026"', "");
    expect(balanzaASerie(sinMes)).toBeNull();
  });

  it("un NumCta repetido se SUMA: la era agrupador trae una fila por subcuenta interna", () => {
    // Forma real de la balanza 2023-01 (agrupador): «102.01» una vez por banco.
    const AGRUPADOR_XML = `<?xml version="1.0" encoding="utf-8"?>
<BCE:Balanza xmlns:BCE="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" Version="1.3" RFC="AMA170817NK1" Mes="1" Anio="2023" TipoEnvio="N">
  <BCE:Ctas NumCta="102" SaldoIni="100" Debe="10" Haber="5" SaldoFin="105"/>
  <BCE:Ctas NumCta="102.01" SaldoIni="60" Debe="6" Haber="3" SaldoFin="63"/>
  <BCE:Ctas NumCta="102.01" SaldoIni="40" Debe="4" Haber="2" SaldoFin="42"/>
</BCE:Balanza>`;
    const s = balanzaASerie(AGRUPADOR_XML)!;
    expect(s.filas).toHaveLength(2);
    const bancos = s.filas.find((f) => f.numCta === "102.01")!;
    expect(bancos).toMatchObject({ saldoIni: 100, debe: 10, haber: 5, saldoFin: 105, esPadre: false });
    expect(s.filas.find((f) => f.numCta === "102")!.esPadre).toBe(true);
  });
});
