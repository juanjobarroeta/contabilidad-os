import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { headersDescargaXlsx, hojaSimple, nombreHoja, toXlsx } from "./xlsx";

/** Lee de vuelta el libro que acabamos de escribir: el round-trip es la prueba. */
function leer(buf: Buffer) {
  return XLSX.read(buf, { type: "buffer", cellDates: true });
}

describe("nombreHoja", () => {
  it("quita los caracteres que Excel prohíbe", () => {
    // Con cualquiera de estos el archivo NO abre — y escribir no da error.
    expect(nombreHoja("Balanza [2025]")).not.toMatch(/[[\]]/);
    expect(nombreHoja("IVA 16%/8%")).not.toMatch(/\//);
    expect(nombreHoja("Aux: cuentas")).not.toMatch(/:/);
  });

  it("recorta a los 31 caracteres del límite de Excel", () => {
    expect(nombreHoja("A".repeat(50))).toHaveLength(31);
  });

  it("nunca devuelve vacío", () => {
    expect(nombreHoja("")).toBe("Hoja");
    expect(nombreHoja("///")).toBe("Hoja");
    expect(nombreHoja("   ")).toBe("Hoja");
  });
});

describe("toXlsx", () => {
  it("los números salen como NÚMEROS, no como texto", () => {
    // El punto entero del formato: que el contador seleccione la columna de
    // importes y Excel le dé la suma. Con CSV son cadenas y no suma nada.
    const wb = leer(toXlsx([{ nombre: "Balanza", headers: ["Cuenta", "Saldo"], rows: [["102.01", 1234.56]] }]));
    const celda = wb.Sheets["Balanza"]["B2"];
    expect(celda.t).toBe("n");
    expect(celda.v).toBe(1234.56);
  });

  it("las fechas salen como FECHAS", () => {
    const fecha = new Date(Date.UTC(2025, 6, 15));
    const wb = leer(toXlsx([{ nombre: "Diario", headers: ["Fecha"], rows: [[fecha]] }]));
    const celda = wb.Sheets["Diario"]["A2"];
    expect(celda.v).toBeInstanceOf(Date);
  });

  it("conserva encabezados y filas en orden", () => {
    const wb = leer(
      toXlsx([
        {
          nombre: "Balanza",
          headers: ["Cuenta", "Nombre", "Cargos", "Abonos"],
          rows: [
            ["102.01", "Bancos nacionales", 100, 0],
            ["201.01", "Proveedores", 0, 100],
          ],
        },
      ])
    );
    const filas = XLSX.utils.sheet_to_json<string[]>(wb.Sheets["Balanza"], { header: 1 });
    expect(filas[0]).toEqual(["Cuenta", "Nombre", "Cargos", "Abonos"]);
    expect(filas[1]).toEqual(["102.01", "Bancos nacionales", 100, 0]);
    expect(filas[2]).toEqual(["201.01", "Proveedores", 0, 100]);
  });

  it("escribe varias hojas en un solo libro", () => {
    // La entrega mensual no es «la balanza»: es balanza + ER + BG juntos.
    const wb = leer(
      toXlsx([
        { nombre: "Balanza", headers: ["A"], rows: [[1]] },
        { nombre: "Estado de resultados", headers: ["B"], rows: [[2]] },
        { nombre: "Balance general", headers: ["C"], rows: [[3]] },
      ])
    );
    expect(wb.SheetNames).toEqual(["Balanza", "Estado de resultados", "Balance general"]);
  });

  it("desambigua nombres repetidos (dos hojas iguales rompen el libro)", () => {
    const wb = leer(
      toXlsx([
        { nombre: "Auxiliar", headers: ["A"], rows: [] },
        { nombre: "Auxiliar", headers: ["A"], rows: [] },
        { nombre: "auxiliar", headers: ["A"], rows: [] },
      ])
    );
    expect(new Set(wb.SheetNames).size).toBe(3);
    expect(wb.SheetNames[0]).toBe("Auxiliar");
  });

  it("los nombres largos repetidos siguen cabiendo en 31 caracteres", () => {
    const largo = "Auxiliar de folios del periodo 2025";
    const wb = leer(toXlsx([{ nombre: largo, headers: ["A"], rows: [] }, { nombre: largo, headers: ["A"], rows: [] }]));
    for (const n of wb.SheetNames) expect(n.length).toBeLessThanOrEqual(31);
    expect(new Set(wb.SheetNames).size).toBe(2);
  });

  it("una hoja sin filas sigue siendo un archivo válido con sus encabezados", () => {
    // Un mes sin movimientos no debe entregar un archivo roto.
    const wb = leer(toXlsx([{ nombre: "Balanza", headers: ["Cuenta", "Saldo"], rows: [] }]));
    const filas = XLSX.utils.sheet_to_json<string[]>(wb.Sheets["Balanza"], { header: 1 });
    expect(filas[0]).toEqual(["Cuenta", "Saldo"]);
  });

  it("un libro sin hojas no revienta", () => {
    const wb = leer(toXlsx([]));
    expect(wb.SheetNames.length).toBeGreaterThan(0);
  });

  it("null y undefined quedan como celdas vacías, no como «null»", () => {
    const wb = leer(toXlsx([{ nombre: "H", headers: ["A", "B"], rows: [[null, undefined]] }]));
    const filas = XLSX.utils.sheet_to_json<string[]>(wb.Sheets["H"], { header: 1, defval: "" });
    expect(filas[1]?.[0] ?? "").toBe("");
    expect(JSON.stringify(filas)).not.toMatch(/null|undefined/);
  });

  it("aplica los anchos de columna", () => {
    // `!cols` sólo vuelve a aparecer al leer con `cellStyles`; sin la opción
    // regresa undefined aunque el archivo SÍ los traiga.
    const buf = toXlsx([{ nombre: "H", headers: ["A", "B"], rows: [], anchos: [40, 12] }]);
    const wb = XLSX.read(buf, { type: "buffer", cellStyles: true });
    expect(wb.Sheets["H"]["!cols"]?.[0]?.wch).toBe(40);
    expect(wb.Sheets["H"]["!cols"]?.[1]?.wch).toBe(12);
  });

  it("hojaSimple es el atajo de una sola hoja", () => {
    const wb = leer(hojaSimple("Papel IVA", ["Concepto"], [["Acreditable"]]));
    expect(wb.SheetNames).toEqual(["Papel IVA"]);
  });
});

describe("headersDescargaXlsx", () => {
  it("declara el MIME de xlsx y el nombre del archivo", () => {
    const h = headersDescargaXlsx("Balanza 2025-07.xlsx");
    expect(h["Content-Type"]).toMatch(/spreadsheetml\.sheet$/);
    expect(h["Content-Disposition"]).toBe('attachment; filename="Balanza 2025-07.xlsx"');
  });

  it("no deja que una comilla en el nombre rompa la cabecera", () => {
    expect(headersDescargaXlsx('a"b.xlsx')["Content-Disposition"]).toBe('attachment; filename="ab.xlsx"');
  });
});
