// ─────────────────────────────────────────────────────────────────────────────
// Bloques de firma dentro de la Descripción del concepto.
//
// Algunos receptores (gobierno) piden que la factura muestre firmas — nombre
// con la línea encima y el cargo debajo — y que TODO quede en el XML. Por eso
// las firmas viven en la propia Descripción con una convención que sobrevive a
// la normalización de espacios del CFDI (no depende de saltos de línea):
//
//   "… Numero de Cuenta: 5588 Firma: C. Edgar Dávila Ramos / Subsecretario de
//    Infraestructura Firma: C. Rodrigo Enrique Álvarez S. / Secretario …"
//
// La representación impresa separa el texto y dibuja cada "Firma:" como bloque.
// El PDF de Facturapi la muestra como texto plano (no controlamos su layout).
// ─────────────────────────────────────────────────────────────────────────────

export type Firma = { nombre: string; cargo: string | null };

const MARCA = /(?:^|\s)firma:\s*/gi;

export function separarFirmas(descripcion: string): { texto: string; firmas: Firma[] } {
  const partes = descripcion.split(MARCA);
  if (partes.length === 1) return { texto: descripcion, firmas: [] };
  const [texto, ...resto] = partes;
  const firmas = resto
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf(" / ");
      return i < 0 ? { nombre: p, cargo: null } : { nombre: p.slice(0, i).trim(), cargo: p.slice(i + 3).trim() || null };
    });
  return { texto: texto.trim(), firmas };
}

/** Texto a agregar a la descripción para una firma nueva. */
export function textoFirma(nombre: string, cargo: string): string {
  return `Firma: ${nombre.trim()} / ${cargo.trim()}`;
}

/** Límite del SAT para cfdi:Concepto/@Descripcion. */
export const MAX_DESCRIPCION = 1000;
