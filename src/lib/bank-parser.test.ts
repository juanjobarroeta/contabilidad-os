import { describe, it, expect } from "vitest";
import { parseStatement } from "./bank-parser";

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
});
