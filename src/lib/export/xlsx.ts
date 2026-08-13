// ─────────────────────────────────────────────────────────────────────────────
// Escritor de XLSX — el gemelo de `toCsv` para lo que el contador entrega.
//
// Por qué no basta el CSV: un CSV entrega TEXTO. El contador abre la balanza,
// selecciona una columna de importes y Excel no le suma nada, porque cada celda
// es una cadena. Aquí los números salen como NÚMEROS y las fechas como FECHAS,
// que es justo lo que convierte un export en una hoja de trabajo.
//
// Un libro puede traer varias hojas: la entrega mensual real no es "la balanza",
// es balanza + estado de resultados + balance general en un solo archivo.
//
// Usa `xlsx` (SheetJS), que ya estaba instalado. Sólo ESCRIBIMOS con él —los
// CVE conocidos de esa versión están en el camino de PARSEO de archivos ajenos,
// que este módulo no toca.
// ─────────────────────────────────────────────────────────────────────────────

import * as XLSX from "xlsx";

export type XlsxCell = string | number | boolean | null | undefined | Date;
export type XlsxRow = XlsxCell[];

export interface HojaXlsx {
  /** Nombre de la pestaña. Se sanea: Excel no abre el archivo si es inválido. */
  nombre: string;
  headers: string[];
  rows: XlsxRow[];
  /** Ancho de cada columna en caracteres. Sin esto todo sale a 8 y se corta. */
  anchos?: number[];
}

/** Excel prohíbe estos caracteres en el nombre de una pestaña. */
const PROHIBIDOS = /[[\]:*?/\\]/g;
const MAX_NOMBRE = 31;

/**
 * Nombre de pestaña válido para Excel: sin caracteres prohibidos, máximo 31
 * caracteres y nunca vacío. Un nombre inválido no da error al escribir — el
 * archivo simplemente no abre, que es peor.
 */
export function nombreHoja(raw: string): string {
  const limpio = raw.replace(PROHIBIDOS, " ").trim().slice(0, MAX_NOMBRE).trim();
  return limpio.length > 0 ? limpio : "Hoja";
}

/** Nombres únicos: dos pestañas iguales rompen el libro. */
function nombresUnicos(nombres: string[]): string[] {
  const vistos = new Map<string, number>();
  return nombres.map((n) => {
    const base = nombreHoja(n);
    const clave = base.toLowerCase();
    const veces = vistos.get(clave) ?? 0;
    vistos.set(clave, veces + 1);
    if (veces === 0) return base;
    // Recorta para que el sufijo quepa en los 31 caracteres.
    const sufijo = ` (${veces + 1})`;
    return base.slice(0, MAX_NOMBRE - sufijo.length) + sufijo;
  });
}

/**
 * Libro de Excel con una o más hojas.
 *
 * Los valores conservan su TIPO: los números se pueden sumar en Excel y las
 * fechas se pueden ordenar y filtrar como fechas.
 */
export function toXlsx(hojas: HojaXlsx[]): Buffer {
  const libro = XLSX.utils.book_new();
  const nombres = nombresUnicos(hojas.map((h) => h.nombre));

  hojas.forEach((hoja, i) => {
    const matriz: XlsxCell[][] = [hoja.headers, ...hoja.rows];
    const ws = XLSX.utils.aoa_to_sheet(matriz, { cellDates: true });
    if (hoja.anchos?.length) {
      ws["!cols"] = hoja.anchos.map((wch) => ({ wch }));
    }
    // Congelar el encabezado: una balanza de 300 filas es ilegible sin esto.
    ws["!freeze"] = { xSplit: "0", ySplit: "1" };
    XLSX.utils.book_append_sheet(libro, ws, nombres[i]);
  });

  // Si no hay hojas, Excel rechaza el archivo: dejamos una vacía.
  if (hojas.length === 0) {
    XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet([[]]), "Hoja");
  }

  return XLSX.write(libro, { type: "buffer", bookType: "xlsx", cellDates: true }) as Buffer;
}

/** Un solo tabulado — el caso común, gemelo exacto de `toCsv`. */
export function hojaSimple(
  nombre: string,
  headers: string[],
  rows: XlsxRow[],
  anchos?: number[]
): Buffer {
  return toXlsx([{ nombre, headers, rows, anchos }]);
}

/**
 * Cabeceras HTTP para devolver un XLSX como descarga.
 * El nombre se entrecomilla: los de verdad llevan espacios y acentos.
 */
export function headersDescargaXlsx(filename: string): Record<string, string> {
  return {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
  };
}
