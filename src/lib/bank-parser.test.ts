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

// ── Banorte CSV (export "Cuentas de Cheques") ────────────────────────────────
// Cabecera real: CUENTA,FECHA DE OPERACIÓN,FECHA,REFERENCIA,DESCRIPCIÓN,
// COD. TRANSAC,SUCURSAL,DEPÓSITOS,RETIROS,SALDO,MOVIMIENTO,DESCRIPCIÓN
// DETALLADA,CHEQUE. Trampas: MOVIMIENTO es un consecutivo (NO un importe),
// DESCRIPCIÓN trae la clave de rastreo (la útil es DESCRIPCIÓN DETALLADA),
// los montos vienen con $ y comas, y las celdas vacías son "-".
const BANORTE_CSV = `﻿CUENTA,FECHA DE OPERACIÓN,FECHA,REFERENCIA,DESCRIPCIÓN,COD. TRANSAC,SUCURSAL,DEPÓSITOS,RETIROS,SALDO,MOVIMIENTO,DESCRIPCIÓN DETALLADA,CHEQUE
'1349182277,03/07/2026,03/07/2026,0,20260703400140HDH0000485641770,3,5663,"$5,127.17",-,"$69,301.50",74,"SPEI RECIBIDO, BCO:0014 SANTANDER, DEL CLIENTE STRIPE PAYMENTS MEXICO S DE RL DE CV, CONCEPTO: STRIPE, REFERENCIA: 0693689",-
'1349182277,14/07/2026,14/07/2026,0,DEPOSITO REFERENCIADO;,537,8846,-,$4.00,"$78,595.76",79,"(BANCA POR INTERNET), CARGO POR COMISION CEP",-
'1349182277,16/07/2026,16/07/2026,160726,COMPRA ORDEN DE PAGO SPEI,511,8846,-,"$2,358.92","$76,236.20",81,"=REFERENCIA  CTA/CLABE: 012180015437920135, BEM SPEI, Pago 1 Julio a Coach Ana",-`;

describe("parseStatement — Banorte CSV", () => {
  const res = parseStatement(BANORTE_CSV, "Cuentas_de_Cheques_Banorte.csv");

  it("detecta Banorte por la firma de encabezados (no Santander por 'sucursal')", () => {
    expect(res.detectedBank).toBe("Banorte");
  });

  it("usa DEPÓSITOS/RETIROS como monto — NO la columna MOVIMIENTO (consecutivo)", () => {
    expect(res.transactions).toHaveLength(3);
    expect(res.transactions[0].monto).toBe(5127.17);   // depósito
    expect(res.transactions[1].monto).toBe(-4.0);      // retiro
    expect(res.transactions[2].monto).toBe(-2358.92);  // retiro
  });

  it("usa DESCRIPCIÓN DETALLADA (no la clave de rastreo) y lee saldo y fecha", () => {
    expect(res.transactions[0].descripcion).toContain("STRIPE PAYMENTS");
    expect(res.transactions[0].saldo).toBe(69301.5);
    expect(res.transactions[0].fecha.getUTCMonth()).toBe(6); // julio
    expect(res.transactions[0].fecha.getUTCDate()).toBe(3);
  });

  it("YA NO TIRA la clave de rastreo: la columna críptica viaja aparte", () => {
    // Es ilegible para una persona, pero es la llave primaria del CEP de
    // Banxico — con ella se pide el RFC de la contraparte.
    expect(res.transactions[0].claveRastreoRaw).toBe("20260703400140HDH0000485641770");
    // Y no se la robó a la descripción legible.
    expect(res.transactions[0].descripcion).toContain("STRIPE PAYMENTS");
  });

  it("no confunde la descripción con clave de rastreo cuando no hay dos columnas", () => {
    // Sin DESCRIPCIÓN DETALLADA ambas resuelven a la misma columna: no hay
    // columna críptica aparte que rescatar.
    const CSV = `FECHA,DESCRIPCION,CARGO,ABONO,SALDO\n03/07/2026,SPEI RECIBIDO STRIPE,-,"1,000.00","5,000.00"`;
    const r = parseStatement(CSV, "generico.csv");
    expect(r.transactions[0].claveRastreoRaw).toBeUndefined();
  });

  it("descarta la referencia de relleno '0'/'-' pero conserva la real", () => {
    expect(res.transactions[0].referencia).not.toBe("0");
    expect(res.transactions[2].referencia).toBe("160726");
  });
});

// ── Movimientos pegados del portal (Scotiabank) ──────────────────────────────
const SCOTIA_PEGADO = `iva transf recepcion internacional
30 Jul 2026 , 12:07:00
-$67.23
transf recepcion internacional
30 Jul 2026 , 12:07:00
$79,068.00
sweb transf. interb spei
28 Jul 2026 , 13:07:00
-$10,000.00
cobranza con recibo 1415
24 Jul 2026 , 12:07:00
-$194,000.00
transf interbancaria spei
23 Jul 2026 , 18:07:00
$210,000.00`;

describe("parseStatement — movimientos pegados del portal (Scotiabank)", () => {
  const res = parseStatement(SCOTIA_PEGADO, "movimientos.txt");

  it("reconoce el formato pegado (descripción / fecha / monto)", () => {
    expect(res.format).toBe("pegado");
    expect(res.transactions).toHaveLength(5);
    expect(res.descartadas).toHaveLength(0);
  });

  it("conserva signo: retiros negativos, depósitos positivos", () => {
    expect(res.transactions[0].monto).toBe(-67.23);
    expect(res.transactions[1].monto).toBe(79068.0);
    expect(res.transactions[4].monto).toBe(210000.0);
  });

  it("parsea la fecha 'DD MMM YYYY , HH:MM:SS'", () => {
    const f = res.transactions[0].fecha;
    expect(f.getUTCFullYear()).toBe(2026);
    expect(f.getUTCMonth()).toBe(6);
    expect(f.getUTCDate()).toBe(30);
  });

  it("asigna la descripción de la línea previa", () => {
    expect(res.transactions[3].descripcion).toBe("cobranza con recibo 1415");
  });

  it("un CSV normal NO cae en el formato pegado", () => {
    const csv = "FECHA,DESCRIPCION,CARGO,ABONO\n01/07/2026,PAGO,100.00,\n02/07/2026,DEPOSITO,,200.00";
    expect(parseStatement(csv, "estado.csv").format).toBe("csv");
  });

  it("reporta (no ignora) una fecha sin monto posterior", () => {
    const roto = SCOTIA_PEGADO + "\nmovimiento incompleto\n22 Jul 2026 , 09:07:00";
    const r = parseStatement(roto, "movimientos.txt");
    expect(r.transactions).toHaveLength(5);
    expect(r.descartadas.length).toBeGreaterThan(0);
  });
});

// ── Movimientos pegados de tarjeta de crédito (Scotiabank) ────────────────────
// El portal de la tarjeta imprime todo sin signo, con "Hoy" para el movimiento
// más reciente, fechas "DD-MMM-YY" y pagos descritos como "su pago gracias"
// (a veces adornados con asteriscos: "*** su pago gracias **").
const SCOTIA_CREDITO_PEGADO = `*** su pago gracias **
Hoy
$2,369.33
su pago en linea gracias
28-Jul-26
$12,198.68
d local*rest rappipro ciudad de mex
27-Jul-26
$69.00
d oxxo gas praderas apodaca
26-Jul-26
$500.00
su pago en linea gracias
20-Jul-26
$8,000.00
d farmacias guadalajara monterrey
19-Jul-26
$1,245.50`;

describe("parseStatement — pegado de tarjeta de crédito (Scotiabank)", () => {
  const res = parseStatement(SCOTIA_CREDITO_PEGADO, "movimientos.txt");

  it("reconoce el formato pegado de la tarjeta", () => {
    expect(res.format).toBe("pegado");
    expect(res.transactions).toHaveLength(5);
  });

  it("omite (con aviso) el movimiento fechado 'Hoy' — el banco aún no lo fecha; importarlo duplicaría al re-importar otro día", () => {
    expect(res.descartadas).toHaveLength(1);
    expect(res.descartadas[0].motivo).toMatch(/hoy/i);
    expect(res.warnings.some(w => /'Hoy'/.test(w))).toBe(true);
    // Ningún movimiento importado lleva la fecha "de hoy".
    expect(res.transactions.some(t => /su pago gracias$/.test(t.descripcion))).toBe(false);
  });

  it("limpia los asteriscos de las descripciones", () => {
    expect(res.transactions[1].descripcion).toBe("d local rest rappipro ciudad de mex");
    for (const t of res.transactions) {
      expect(t.descripcion).not.toMatch(/\*/);
    }
  });

  it("parsea fechas 'DD-MMM-YY' con año de dos dígitos", () => {
    const f = res.transactions[0].fecha;
    expect(f.getUTCFullYear()).toBe(2026);
    expect(f.getUTCMonth()).toBe(6);
    expect(f.getUTCDate()).toBe(28);
  });

  it("los pagos ('su pago … gracias') quedan como abonos (+)", () => {
    expect(res.transactions[0].monto).toBe(12198.68);
    expect(res.transactions[3].monto).toBe(8000.0);
  });

  it("los cargos quedan como retiros (−)", () => {
    expect(res.transactions[1].monto).toBe(-69.0);
    expect(res.transactions[2].monto).toBe(-500.0);
    expect(res.transactions[4].monto).toBe(-1245.5);
  });

  it("avisa que se detectó formato de tarjeta de crédito", () => {
    expect(res.warnings.some(w => /tarjeta de crédito/i.test(w))).toBe(true);
  });

  it("el pegado de débito (con signos) NO dispara la heurística de tarjeta", () => {
    const r = parseStatement(SCOTIA_PEGADO, "movimientos.txt");
    expect(r.warnings.some(w => /tarjeta de crédito/i.test(w))).toBe(false);
    expect(r.transactions[0].monto).toBe(-67.23);
  });
});

// ── Hora del pegado + montos en formato europeo ──────────────────────────────
// La hora de la línea de fecha identifica al movimiento dentro del día (dos
// SPEI de $10,000 el 13 de julio a las 13:07 y 15:07 son transacciones
// distintas — la dedup la usa como desempate). Algunos perfiles del portal
// imprimen los montos estilo europeo ("-$10.000,00").
describe("parseStatement — pegado: hora y montos europeos", () => {
  const CON_DUPLICADOS = `sweb transf. interb spei
13 Jul 2026 , 15:07:00
-$10,000.00
sweb transf. interb spei
13 Jul 2026 , 13:07:00
-$618.00
sweb transf. interb spei
13 Jul 2026 , 13:07:00
-$10,000.00`;

  it("captura la hora normalizada HH:MM:SS de cada movimiento", () => {
    const r = parseStatement(CON_DUPLICADOS, "movimientos.txt");
    expect(r.transactions.map((t) => t.hora)).toEqual(["15:07:00", "13:07:00", "13:07:00"]);
  });

  it("dos movimientos idénticos el mismo día se parsean AMBOS", () => {
    const r = parseStatement(CON_DUPLICADOS, "movimientos.txt");
    expect(r.transactions.filter((t) => t.monto === -10000)).toHaveLength(2);
    expect(r.descartadas).toHaveLength(0);
  });

  it("hora con minutos sin segundos se normaliza (9:07 → 09:07:00)", () => {
    const r = parseStatement(
      "pago servicio\n09 Jul 2026 , 9:07\n-$300.00\npago servicio\n08 Jul 2026 , 14:07\n-$150.00",
      "movimientos.txt",
    );
    expect(r.transactions[0].hora).toBe("09:07:00");
  });

  it("acepta montos en formato europeo ($10.000,00) y mixto", () => {
    const eu = `sweb transf. interb spei
17 Jul 2026 , 11:07:00
-$3.580,00
transf interbancaria spei
15 Jul 2026 , 16:07:00
$14.300,00
sweb transf. interb spei
13 Jul 2026 , 15:07:00
-$10.000,00`;
    const r = parseStatement(eu, "movimientos.txt");
    expect(r.format).toBe("pegado");
    expect(r.transactions.map((t) => t.monto)).toEqual([-3580, 14300, -10000]);
    expect(r.descartadas).toHaveLength(0);
  });
});
