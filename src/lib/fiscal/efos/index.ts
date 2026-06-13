// 69-B / EFOS — empresas que facturan operaciones simuladas (Art. 69-B CFF).
export * from "./types";
export { parseEfosCsv, normalizarSituacion } from "./parse";
export { revisarEfos, revisarRfcs } from "./check";
export { descargarListaEfos, EFOS_URL_DEFAULT } from "./download";
