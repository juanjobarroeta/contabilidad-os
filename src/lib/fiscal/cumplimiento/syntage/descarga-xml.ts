// ─────────────────────────────────────────────────────────────────────────────
// Descarga de archivos XML de Syntage, con soporte de ZIP.
//
// Los archivos de Contabilidad Electrónica que Syntage trae del SAT llegan tal
// cual el SAT los entrega: COMPRIMIDOS (`AMA170817NK1202312BN.zip`, …CT.zip).
// El import automático los descargaba y los pasaba DIRECTO a los parsers de
// XML como texto: el regex no encuentra `<Ctas` en bytes de zip, devuelve 0
// cuentas sin error, y el arranque de CE reportaba `importado:false` en cada
// sync sin pista alguna (caso real: MARGOM, 69 registros visibles en Syntage
// y ceBootstrap vacío por semanas).
//
// Aquí: si los bytes descargados traen la firma ZIP ("PK"), se abre el zip y
// se extrae la primera entrada .xml; si no, se decodifica como texto UTF-8.
// ─────────────────────────────────────────────────────────────────────────────

import JSZip from "jszip";

/** Subconjunto del SyntageClient que necesitamos (facilita el test con stub). */
export interface DescargadorDeArchivos {
  downloadAcuse(ref: string): Promise<{ data: ArrayBuffer }>;
}

const esZip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x50 && b[1] === 0x4b; // "PK"

export async function descargarXmlDeRef(
  client: DescargadorDeArchivos,
  ref: string,
): Promise<string> {
  const { data } = await client.downloadAcuse(ref);
  const bytes = new Uint8Array(data);
  if (esZip(bytes)) {
    const zip = await JSZip.loadAsync(bytes);
    const entrada = Object.values(zip.files).find(
      (f) => !f.dir && f.name.toLowerCase().endsWith(".xml"),
    );
    if (!entrada) {
      throw new Error(`El zip descargado de ${ref} no contiene ningún .xml`);
    }
    return entrada.async("text");
  }
  return new TextDecoder("utf-8").decode(bytes);
}
