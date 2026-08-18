import { describe, expect, it } from "vitest";
import {
  decodificarEstadoDeCuenta,
  esExcelBinario,
  esSpreadsheetML,
  repararMojibake,
  tieneMojibake,
} from "./decodificar";

// El renglón real que salió roto en la app: "Comisi<?>n por Transferencia -
// Env<?>o". En Windows-1252 la ó es 0xF3 y la í es 0xED.
const CP1252 = Buffer.from([
  0x43, 0x6f, 0x6d, 0x69, 0x73, 0x69, 0xf3, 0x6e, 0x20, 0x70, 0x6f, 0x72, 0x20,
  0x54, 0x72, 0x61, 0x6e, 0x73, 0x66, 0x65, 0x72, 0x65, 0x6e, 0x63, 0x69, 0x61,
  0x20, 0x2d, 0x20, 0x45, 0x6e, 0x76, 0xed, 0x6f,
]);

describe("decodificarEstadoDeCuenta", () => {
  it("rescata los acentos de un CSV Windows-1252 — el bug real", () => {
    const r = decodificarEstadoDeCuenta(CP1252);
    expect(r.texto).toBe("Comisión por Transferencia - Envío");
    expect(r.codificacion).toBe("windows-1252");
    expect(tieneMojibake(r.texto)).toBe(false);
  });

  it("demuestra el daño: los mismos bytes leídos como UTF-8", () => {
    // Esto es exactamente lo que hacía `await file.text()` en el navegador.
    expect(tieneMojibake(CP1252.toString("utf8"))).toBe(true);
  });

  it("deja intacto un UTF-8 legítimo", () => {
    const r = decodificarEstadoDeCuenta(Buffer.from("Comisión por Transferencia", "utf8"));
    expect(r.texto).toBe("Comisión por Transferencia");
    expect(r.codificacion).toBe("utf8");
  });

  it("no confunde UTF-8 con Windows-1252 (el error inverso, silencioso)", () => {
    // Un UTF-8 leído como cp1252 daría "ComisiÃ³n": no truena, sólo ensucia.
    const r = decodificarEstadoDeCuenta(Buffer.from("Comisión", "utf8"));
    expect(r.texto).not.toContain("Ã");
  });

  it("respeta el BOM que el archivo ya declaró", () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Comisión", "utf8")]);
    const r = decodificarEstadoDeCuenta(bom);
    expect(r.texto).toBe("Comisión"); // sin el BOM pegado al frente
    expect(r.codificacion).toBe("utf8-bom");
  });

  it("lee UTF-16 en sus dos órdenes de bytes", () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Envío", "utf16le")]);
    expect(decodificarEstadoDeCuenta(le)).toEqual({ texto: "Envío", codificacion: "utf16le" });

    const be = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from(Buffer.from("Envío", "utf16le")).swap16(),
    ]);
    expect(decodificarEstadoDeCuenta(be)).toEqual({ texto: "Envío", codificacion: "utf16be" });
  });

  it("no muta el buffer de entrada al voltear UTF-16BE", () => {
    const original = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from(Buffer.from("Envío", "utf16le")).swap16(),
    ]);
    const copia = Buffer.from(original);
    decodificarEstadoDeCuenta(original);
    expect(original.equals(copia)).toBe(true);
  });

  it("no rompe con vacío", () => {
    expect(decodificarEstadoDeCuenta(Buffer.alloc(0)).texto).toBe("");
  });
});

describe("esExcelBinario", () => {
  it("reconoce xlsx (zip PK) y xls viejo (OLE2)", () => {
    expect(esExcelBinario(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(esExcelBinario(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))).toBe(true);
  });

  it("NO manda un CSV a SheetJS aunque venga con nombre .xls", () => {
    // Ese desvío re-emite el archivo con la idea que SheetJS tenga de la
    // codificación: otra fuente de acentos rotos.
    expect(esExcelBinario(Buffer.from("FECHA,CONCEPTO,MONTO\n", "utf8"))).toBe(false);
  });

  it("no rompe con vacío ni con un solo byte", () => {
    expect(esExcelBinario(Buffer.alloc(0))).toBe(false);
    expect(esExcelBinario(Buffer.from([0x50]))).toBe(false);
  });
});

describe("esSpreadsheetML", () => {
  it("reconoce el .xls de BBVA que en realidad es XML", () => {
    expect(esSpreadsheetML('<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>')).toBe(true);
    expect(esSpreadsheetML('<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet">')).toBe(true);
  });

  it("no confunde un CSV normal", () => {
    expect(esSpreadsheetML("FECHA,CONCEPTO,MONTO\n01/07/2026,SPEI,100")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reparación de lo YA dañado. Renglones reales de Bajío tal como se ven hoy
// en la app, con el U+FFFD donde iba el acento.
// ─────────────────────────────────────────────────────────────────────────────

describe("repararMojibake", () => {
  it("repara el renglón real de la comisión", () => {
    expect(
      repararMojibake("Comisi�n por Transferencia - Env�o ; (SPEI; Banca por Internet)")
    ).toBe("Comisión por Transferencia - Envío ; (SPEI; Banca por Internet)");
  });

  it("repara el renglón real del IVA, con sus tres palabras dañadas", () => {
    expect(
      repararMojibake(
        "IVA Comisi�n por Transferencia | N�mero de Referencia: BB4251954020513 | N�mero de Autorizaci�n: 4242167020513"
      )
    ).toBe(
      "IVA Comisión por Transferencia | Número de Referencia: BB4251954020513 | Número de Autorización: 4242167020513"
    );
  });

  it("respeta MAYÚSCULAS", () => {
    expect(repararMojibake("COMISI�N POR TRANSFERENCIA")).toBe("COMISIÓN POR TRANSFERENCIA");
    expect(repararMojibake("DEP�SITO EN EFECTIVO")).toBe("DEPÓSITO EN EFECTIVO");
  });

  it("NO inventa: lo que no está en la lista conserva su daño", () => {
    // Un nombre propio dañado tiene varias lecturas posibles. Adivinarlo sería
    // falsificar el estado de cuenta; un carácter roto y honesto es mejor.
    const nombre = "JOS� MAR�A GONZ�LEZ";
    expect(repararMojibake(nombre)).toBe(nombre);
    expect(tieneMojibake(repararMojibake(nombre))).toBe(true);
  });

  it("no toca texto sano ni vacío", () => {
    expect(repararMojibake("Comisión por Transferencia")).toBe("Comisión por Transferencia");
    expect(repararMojibake("")).toBe("");
  });
});
