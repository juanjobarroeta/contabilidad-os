import { describe, it, expect } from "vitest";
import { parseStatement, parseMXNumber } from "./bank-parser";

// Fixture representativo de un export .xls de BBVA ("RSM" / Banca Net Cash):
// NO es Excel binario, es SpreadsheetML 2003 (XML). Reproduce lo esencial:
//  - metadatos de "BBVA Bancomer" (detección de banco),
//  - una fila basura de "Cuenta" antes del encabezado,
//  - encabezado "Fecha Operación | Concepto | Referencia | Referencia Ampliada | Cargo | Abono | Saldo",
//  - fechas ISO (2026-06-30),
//  - una fila ABONO (omite la celda Cargo con ss:Index) y una fila CARGO.
const BBVA_SPREADSHEETML = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office"><Company>BBVA Bancomer, S.A.</Company></DocumentProperties>
 <Worksheet ss:Name="Hoja1"><Table>
  <Row><Cell><Data ss:Type="String">Cuenta</Data></Cell><Cell><Data ss:Type="String">0122801809</Data></Cell></Row>
  <Row>
   <Cell><Data ss:Type="String">Fecha Operación</Data></Cell>
   <Cell><Data ss:Type="String">Concepto</Data></Cell>
   <Cell><Data ss:Type="String">Referencia</Data></Cell>
   <Cell><Data ss:Type="String">Referencia Ampliada</Data></Cell>
   <Cell><Data ss:Type="String">Cargo</Data></Cell>
   <Cell><Data ss:Type="String">Abono</Data></Cell>
   <Cell><Data ss:Type="String">Saldo</Data></Cell>
  </Row>
  <Row>
   <Cell><Data ss:Type="String">2026-06-30</Data></Cell>
   <Cell><Data ss:Type="String">SPEI DEVUELTO BAJIO</Data></Cell>
   <Cell><Data ss:Type="String">0000789161</Data></Cell>
   <Cell><Data ss:Type="String">PAGO FACTURA</Data></Cell>
   <Cell ss:Index="6"><Data ss:Type="Number">22732.50</Data></Cell>
   <Cell><Data ss:Type="Number">23080.37</Data></Cell>
  </Row>
  <Row>
   <Cell><Data ss:Type="String">2026-06-30</Data></Cell>
   <Cell><Data ss:Type="String">SPEI ENVIADO BANAMEX</Data></Cell>
   <Cell><Data ss:Type="String">0000641055</Data></Cell>
   <Cell><Data ss:Type="String">PAGO NOMINA</Data></Cell>
   <Cell><Data ss:Type="Number">4725.60</Data></Cell>
   <Cell ss:Index="7"><Data ss:Type="Number">18354.77</Data></Cell>
  </Row>
 </Table></Worksheet>
</Workbook>`;

describe("parseStatement — BBVA SpreadsheetML (.xls que es XML)", () => {
  const res = parseStatement(BBVA_SPREADSHEETML, "RSM_00640085.xls");

  it("enruta al parser de SpreadsheetML y detecta BBVA", () => {
    expect(res.format).toBe("spreadsheetml");
    expect(res.detectedBank).toBe("BBVA");
  });

  it("extrae los movimientos (salta la fila basura de 'Cuenta')", () => {
    expect(res.transactions).toHaveLength(2);
  });

  it("parsea la fecha ISO correctamente (2026-06-30)", () => {
    const f = res.transactions[0].fecha;
    expect(f.getUTCFullYear()).toBe(2026);
    expect(f.getUTCMonth()).toBe(5); // junio (0-indexed)
    expect(f.getUTCDate()).toBe(30);
  });

  it("ABONO = crédito positivo; CARGO = débito negativo", () => {
    expect(res.transactions[0].monto).toBeCloseTo(22732.5, 2); // abono
    expect(res.transactions[1].monto).toBeCloseTo(-4725.6, 2); // cargo
  });

  it("combina Referencia + Referencia Ampliada", () => {
    expect(res.transactions[0].referencia).toContain("0000789161");
    expect(res.transactions[0].referencia).toContain("PAGO FACTURA");
  });

  it("no descarta ninguna fila con datos válidos", () => {
    expect(res.descartadas).toEqual([]);
  });
});

// ── OFX: montos con separador de miles / coma decimal ────────────────────────
// Regresión: parseOFX hacía amtStr.replace(",", ".") a ciegas, con lo que
// "1,234.56" (miles) se convertía en "1.234.56" → parseFloat → 1.234. El
// banco es la fuente de verdad: un monto mal leído es pérdida de datos.
function ofxConMontos(montos: string[]): string {
  const bloques = montos.map((m, i) => `<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260615
<TRNAMT>${m}
<FITID>FIT${i + 1}
<MEMO>MOVIMIENTO ${i + 1}
</STMTTRN>`).join("\n");
  return `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
${bloques}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

describe("parseStatement — OFX montos", () => {
  it("1,234.56 (separador de miles americano) → 1234.56", () => {
    const res = parseStatement(ofxConMontos(["1,234.56"]), "estado.ofx");
    expect(res.format).toBe("ofx");
    expect(res.transactions).toHaveLength(1);
    expect(res.transactions[0].monto).toBeCloseTo(1234.56, 2);
  });

  it("-1234.56 (negativo simple) → -1234.56", () => {
    const res = parseStatement(ofxConMontos(["-1234.56"]), "estado.ofx");
    expect(res.transactions[0].monto).toBeCloseTo(-1234.56, 2);
  });

  it("1234,56 (coma decimal europea) → 1234.56", () => {
    const res = parseStatement(ofxConMontos(["1234,56"]), "estado.ofx");
    expect(res.transactions[0].monto).toBeCloseTo(1234.56, 2);
  });

  it("1234.56 (punto decimal simple) → 1234.56", () => {
    const res = parseStatement(ofxConMontos(["1234.56"]), "estado.ofx");
    expect(res.transactions[0].monto).toBeCloseTo(1234.56, 2);
  });

  it("los cuatro formatos en un mismo archivo, sin perder filas", () => {
    const res = parseStatement(ofxConMontos(["1,234.56", "-1234.56", "1234,56", "1234.56"]), "estado.ofx");
    expect(res.transactions).toHaveLength(4);
    expect(res.transactions.map(t => t.monto)).toEqual([1234.56, -1234.56, 1234.56, 1234.56]);
    expect(res.descartadas).toEqual([]);
  });

  it("fecha ilegible en un bloque → descartada con el valor crudo, sin tumbar el resto", () => {
    const contenido = ofxConMontos(["100.00", "200.00"]).replace("<DTPOSTED>20260615\n<TRNAMT>200.00", "<DTPOSTED>XXXX\n<TRNAMT>200.00");
    const res = parseStatement(contenido, "estado.ofx");
    expect(res.transactions).toHaveLength(1);
    expect(res.descartadas).toHaveLength(1);
    expect(res.descartadas[0].fila).toBe(2);
    expect(res.descartadas[0].motivo).toContain("XXXX");
  });
});

describe("parseMXNumber", () => {
  it("maneja miles y decimales en ambos estilos", () => {
    expect(parseMXNumber("1,234.56")).toBeCloseTo(1234.56, 2);
    expect(parseMXNumber("-1234.56")).toBeCloseTo(-1234.56, 2);
    expect(parseMXNumber("1234,56")).toBeCloseTo(1234.56, 2);
    expect(parseMXNumber("1234.56")).toBeCloseTo(1234.56, 2);
    expect(parseMXNumber("1.234.567,89")).toBeCloseTo(1234567.89, 2);
    expect(parseMXNumber("$1,234,567.89")).toBeCloseTo(1234567.89, 2);
  });
});

// ── CSV: acumulación de motivos de descarte (nada se pierde en silencio) ─────
describe("parseStatement — CSV filas descartadas", () => {
  it("una fila con fecha ilegible → 1 descartada con el valor crudo y su número de fila", () => {
    const csv = [
      "Fecha,Descripcion,Monto",
      "30/06/2026,PAGO PROVEEDOR,-1500.00",
      "15/06/26,CARGO RARO,-200.00", // año de 2 dígitos: el parser no lo acepta
      "01/07/2026,DEPOSITO CLIENTE,3200.50",
    ].join("\n");
    const res = parseStatement(csv, "estado.csv");
    expect(res.format).toBe("csv");
    expect(res.transactions).toHaveLength(2);
    expect(res.descartadas).toHaveLength(1);
    expect(res.descartadas[0].fila).toBe(3); // línea 3 del archivo (1-based)
    expect(res.descartadas[0].motivo).toContain("fecha inválida");
    expect(res.descartadas[0].motivo).toContain("15/06/26");
  });

  it("monto ilegible → descartada con el valor crudo", () => {
    const csv = [
      "Fecha,Descripcion,Monto",
      "30/06/2026,PAGO PROVEEDOR,abc",
      "01/07/2026,DEPOSITO CLIENTE,3200.50",
    ].join("\n");
    const res = parseStatement(csv, "estado.csv");
    expect(res.transactions).toHaveLength(1);
    expect(res.descartadas).toHaveLength(1);
    expect(res.descartadas[0].fila).toBe(2);
    expect(res.descartadas[0].motivo).toContain("monto inválido");
    expect(res.descartadas[0].motivo).toContain("abc");
  });

  it("archivo limpio → descartadas vacío", () => {
    const csv = [
      "Fecha,Descripcion,Monto",
      "30/06/2026,PAGO PROVEEDOR,-1500.00",
      "01/07/2026,DEPOSITO CLIENTE,3200.50",
    ].join("\n");
    const res = parseStatement(csv, "estado.csv");
    expect(res.transactions).toHaveLength(2);
    expect(res.descartadas).toEqual([]);
  });

  it("dos filas idénticas dentro del archivo se conservan ambas (el dedup es en la importación, no en el parseo)", () => {
    const csv = [
      "Fecha,Descripcion,Monto",
      "30/06/2026,UBER TRIP,-450.50",
      "30/06/2026,UBER TRIP,-450.50",
    ].join("\n");
    const res = parseStatement(csv, "estado.csv");
    expect(res.transactions).toHaveLength(2);
    expect(res.descartadas).toEqual([]);
  });
});
