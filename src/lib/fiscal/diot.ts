// ─────────────────────────────────────────────────────────────────────────────
// Serialización de la DIOT — layouts de carga batch del SAT (funciones PURAS).
//
// Dos layouts:
//
//   1. DIOT 2025 (`lineaDiot2025`) — layout VIGENTE de carga masiva de la
//      nueva plataforma DIOT (ejercicios 2025 en adelante): 54 campos por
//      línea, delimitados por pipe (|), SIN encabezado, codificación UTF-8 y
//      montos en pesos ENTEROS ("No permite decimales. Acepta cero.").
//      Fuente: SAT, "Instructivo para el armado del archivo de carga masiva —
//      Declaración informativa de operaciones con terceros (DIOT)", Enero
//      2025, sección 3 (enlazado desde la ficha del trámite en
//      wwwmat.sat.gob.mx/declaracion/74295). Ver docs/DIOT-2025.md para la
//      tabla completa de campos, el mapeo desde nuestros datos y las
//      limitaciones conocidas.
//
//   2. Legacy DEM (`lineaDiotLegacy`) — el layout batch anterior de 15 campos
//      (plataforma DEM, ya no funcional en el SAT desde 2025). Se conserva
//      detrás de ?layout=legacy sólo por compatibilidad/depuración.
//
// La agregación por proveedor (base de flujo de efectivo, Art. 1-B LIVA) vive
// en el llamador (/api/impuestos/diot) sobre operacionesEgresoFlujo — aquí
// SÓLO se serializa; las cifras no se alteran, únicamente se redondean según
// la convención de cada layout.
// ─────────────────────────────────────────────────────────────────────────────

/** Tipo de tercero (catálogo SAT, igual en ambos layouts). */
export type TipoTerceroDiot = "04" | "05" | "15"; // Nacional | Extranjero | Global

/**
 * Agregado por proveedor (cifras del mes, base de flujo de efectivo) — el
 * subconjunto que necesitan ambos serializadores.
 */
export interface ProveedorDiot {
  rfc: string;
  razonSocial: string;
  tipoTercero: TipoTerceroDiot;
  /** Base pagada gravada a 16% (o tasa/cuota > 0). */
  valorActosGravados16: number;
  /** IVA acreditable efectivamente pagado (16%). */
  ivaTrasladadoPagado16: number;
  /** Base pagada gravada a tasa 0% (≠ exentos). */
  valorActosGravados0: number;
  /** Actos exentos pagados. */
  valorActosExentos: number;
  /** IVA pagado NO acreditable (bandera manual / 69-B). */
  ivaNoAcreditable: number;
  /** IVA que retuvimos al proveedor. */
  ivaRetenido: number;
}

/** Número de campos por línea del layout DIOT 2025 (instructivo SAT, sección 3). */
export const CAMPOS_DIOT_2025 = 54;

/**
 * Tipo de operación por tipo de tercero (campo 2, catálogo del instructivo).
 * No distinguimos la naturaleza de la operación en nuestros datos, así que se
 * usa el valor más general disponible por tipo de tercero:
 *   - Nacional: 85 "Otros" (el catálogo nacional es 02/03/06/08/85).
 *   - Extranjero: 07 "Importación de bienes o servicios" (el catálogo
 *     extranjero es 02/03/07 — NO existe 85; el pago a un residente en el
 *     extranjero se reporta como importación, el caso general).
 *   - Global: 87 "Operaciones globales" (único valor permitido).
 */
export const TIPO_OPERACION_POR_TERCERO: Record<TipoTerceroDiot, string> = {
  "04": "85",
  "05": "07",
  "15": "87",
};

/** RFC genérico de operaciones con extranjeros (no es una clave real del RFC). */
const RFC_GENERICO_EXTRANJERO = "XEXX010101000";

/** Pesos enteros — el layout 2025 no permite decimales. */
const pesos = (n: number) => String(Math.round(n));

/**
 * Una línea del archivo de carga masiva DIOT 2025 (54 campos, ver
 * docs/DIOT-2025.md por el detalle campo a campo).
 *
 * Convenciones de llenado desde nuestros datos:
 *   - Nacional/Global: bases e IVA van en la categoría "Actos o actividades
 *     totales pagados a la tasa del 16% de IVA"; exentos al campo 50 y tasa 0%
 *     al campo 51.
 *   - Extranjero (tipo de operación 07): bases e IVA van en la categoría
 *     "importación de bienes intangibles y servicios a la tasa del 16%"
 *     (no distinguimos tangible/intangible; ver limitaciones en docs) y los
 *     exentos al campo 49 (importación exenta).
 *   - IVA no acreditable (bandera manual / 69-B) → "Asociado a actividades que
 *     no cumple con requisitos" de la misma categoría que la base.
 *   - Manifiesto (campo 54): 01 "Sí" salvo que TODO el IVA del proveedor sea
 *     no acreditable (69-B / bandera), en cuyo caso 02 "No".
 *   - Campos que nuestros datos no distinguen (región fronteriza, importación
 *     por aduana, proporción del Art. 5-V por proveedor, devoluciones, no
 *     objeto) → 0, la convención "Acepta cero" del instructivo.
 */
export function lineaDiot2025(p: ProveedorDiot): string {
  const c = new Array<string>(CAMPOS_DIOT_2025).fill("0");
  const extranjero = p.tipoTercero === "05";

  // ── 3.1 Datos del tercero declarado (campos 1-7) ──────────────────────────
  c[0] = p.tipoTercero;
  c[1] = TIPO_OPERACION_POR_TERCERO[p.tipoTercero];
  // RFC: obligatorio nacional/global; para extranjero es opcional y XEXX no es
  // una clave real del RFC (el SAT valida existencia) — se deja vacío.
  c[2] = extranjero ? "" : p.rfc;
  // Número de identificación fiscal (sólo extranjero): si el "rfc" almacenado
  // no es el genérico XEXX, es un identificador extranjero real y se usa.
  c[3] = extranjero && p.rfc !== RFC_GENERICO_EXTRANJERO ? p.rfc : "";
  c[4] = extranjero ? p.razonSocial.substring(0, 300) : ""; // nombre del extranjero
  c[5] = ""; // país o jurisdicción de residencia fiscal — no lo tenemos (ver docs)
  c[6] = ""; // especificar lugar de jurisdicción fiscal (sólo cuando país = ZZZ)

  // ── 3.2 Valor de los actos o actividades (campos 8-17) ────────────────────
  // 8-9 región fronteriza norte, 10-11 región fronteriza sur: no operamos
  // tasas de región fronteriza → 0.
  if (extranjero) {
    c[15] = pesos(p.valorActosGravados16); // 16 valor importación intangibles/servicios 16%
    // 17 devoluciones importación intangibles → 0 (no las distinguimos)
  } else {
    c[11] = pesos(p.valorActosGravados16); // 12 valor actos totales pagados 16%
    // 13 devoluciones 16% → 0 (no las distinguimos)
  }
  // 14-15 importación por aduana de bienes tangibles → 0.

  // ── 3.3 IVA acreditable (campos 18-27) ─────────────────────────────────────
  // Todo el IVA acreditable se reporta como "exclusivamente de actividades
  // gravadas"; la proporción del Art. 5-V del motor es global, no por proveedor.
  if (extranjero) {
    c[25] = pesos(p.ivaTrasladadoPagado16); // 26 exclusivamente gravadas / import. intangibles
  } else {
    c[21] = pesos(p.ivaTrasladadoPagado16); // 22 exclusivamente gravadas / 16%
  }

  // ── 3.4 IVA no acreditable (campos 28-47) ──────────────────────────────────
  // Bandera manual / 69-B ≈ "no cumple con requisitos" (Art. 5-I LIVA /
  // Art. 69-B CFF), en la misma categoría que la base.
  if (extranjero) {
    c[44] = pesos(p.ivaNoAcreditable); // 45 no cumple requisitos / import. intangibles
  } else {
    c[36] = pesos(p.ivaNoAcreditable); // 37 no cumple requisitos / 16%
  }

  // ── 3.5 Datos adicionales (campos 48-54) ───────────────────────────────────
  c[47] = pesos(p.ivaRetenido); // 48 IVA retenido por el contribuyente
  if (extranjero) {
    c[48] = pesos(p.valorActosExentos); // 49 importación exenta
  } else {
    c[49] = pesos(p.valorActosExentos); // 50 actos pagados exentos
  }
  c[50] = pesos(p.valorActosGravados0); // 51 demás actos pagados a tasa 0%
  // 52 no objeto en territorio nacional, 53 no objeto sin establecimiento → 0
  // (nuestros datos legacy no separan "no objeto" de "exento"; ver docs).
  const ivaAcred = Math.round(p.ivaTrasladadoPagado16);
  const ivaNoAcred = Math.round(p.ivaNoAcreditable);
  c[53] = ivaAcred === 0 && ivaNoAcred > 0 ? "02" : "01"; // 54 manifiesto efectos fiscales

  return c.join("|");
}

/** Archivo completo DIOT 2025: una línea por proveedor, CRLF, sin encabezado. */
export function archivoDiot2025(proveedores: ProveedorDiot[]): string {
  return proveedores.map(lineaDiot2025).join("\r\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout LEGACY (DEM, 15 campos) — comportamiento histórico sin cambios.
//
// TipoTercero|RFC|RazonSocial|PaisResidencia|Nacionalidad|
// ValorActosGravados16|ValorActosGravados15|ValorActosGravados0|
// ValorActosExentos|IVARetenido|IVATrasladado|
// ValorActosGravadosIEPS|ValorActosExentosIEPS|
// IVANoAcreditable|ValorActosNoObjeto
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

export function lineaDiotLegacy(p: ProveedorDiot): string {
  return [
    p.tipoTercero,
    p.rfc,
    p.razonSocial.substring(0, 300),
    "", // país
    "", // nacionalidad
    r2(p.valorActosGravados16).toFixed(2), // gravados 16% (base pagada)
    "0", // gravados 15% (obsoleto)
    r2(p.valorActosGravados0).toFixed(2), // gravados 0% (base pagada, ≠ exentos)
    r2(p.valorActosExentos).toFixed(2), // exentos (sin traslado de IVA o TipoFactor=Exento)
    r2(p.ivaRetenido).toFixed(2), // IVA retenido
    r2(p.ivaTrasladadoPagado16).toFixed(2), // IVA trasladado (acreditable, efectivamente pagado)
    "0", // IEPS gravados
    "0", // IEPS exentos
    r2(p.ivaNoAcreditable).toFixed(2), // IVA no acreditable (bandera manual / 69-B)
    "0", // no objeto
  ].join("|");
}

/** Archivo completo legacy: una línea por proveedor, CRLF, sin encabezado. */
export function archivoDiotLegacy(proveedores: ProveedorDiot[]): string {
  return proveedores.map(lineaDiotLegacy).join("\r\n");
}
