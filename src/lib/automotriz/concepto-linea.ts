// ─────────────────────────────────────────────────────────────────────────────
// A qué línea del negocio pertenece UN concepto de un CFDI.
//
// Dos derivadores leían los mismos conceptos con reglas distintas y sin saber
// uno del otro: el de taller reclamaba como mano de obra todo lo que dijera
// SERVICIO/REPARACIÓN/MANTENIMIENTO en la descripción, y el de kardex escribía
// como refacción todo lo que trajera NoIdentificacion. Un concepto que cumple
// las dos cosas caía en las dos líneas.
//
// No es un caso raro: el catálogo de refacciones está lleno de partes que se
// llaman «reparación» —«KIT DE REPARACIÓN DE CALIPER», «KIT DE REPARACIÓN DE
// PLACAS DE FRICCIÓN», «BOLSA DE REPARACIÓN DE FORRO DE CESTA»— y todas traen
// número de parte. Cada una se contaba como mano de obra Y como refacción.
//
// La cura no es parchar el regex de un lado: es que los dos lados pregunten
// aquí. Mientras la decisión viva duplicada, va a volver a separarse.
//
// PRECEDENCIA, y el orden importa:
//
//   1. Anticipo            → NINGUNA. No es venta: es cobro a cuenta que la
//                            factura final sustituye (clave 84111506).
//   2. Clave 7818xx        → MANO_OBRA. Es la clave del SAT para servicios de
//                            mantenimiento y reparación de vehículos: es
//                            autoritativa y gana incluso con número de parte,
//                            porque un taller sí codifica sus operaciones.
//   3. NoIdentificacion    → REFACCION. Una pieza con número de parte es una
//                            pieza, diga lo que diga su nombre. Es la regla que
//                            rescata los «KIT DE REPARACIÓN».
//   4. Texto de servicio   → MANO_OBRA. Lo más débil: sólo decide cuando no hay
//                            ni clave autoritativa ni número de parte.
//   5. Nada de lo anterior → NINGUNA.
// ─────────────────────────────────────────────────────────────────────────────

export type LineaConcepto = "MANO_OBRA" | "REFACCION" | "NINGUNA";

/** Anticipo del bien o servicio (Anexo 20). Su descripción trae «SERVICIO». */
export const CLAVE_ANTICIPO = "84111506";
const ANTICIPO_TEXTO_RE = /\bANTICIPO\b/i;

/** Clave del SAT de servicios de mantenimiento y reparación de vehículos. */
const CLAVE_TALLER = "7818";

/**
 * Segmentos de SERVICIO del catálogo del SAT. Una parte física nunca vive aquí,
 * así que un NoIdentificacion bajo una de estas claves es un código de
 * operación, no un número de parte.
 */
const CLAVE_SERVICIO_RE = /^(7[89]|8[0-9]|9[0-5])/;

/**
 * Texto de servicio. Deliberadamente el criterio MÁS DÉBIL: «REPARACIÓN» y
 * «MANTENIMIENTO» aparecen en el nombre de muchísimas refacciones, y
 * «SERVICIO» aparece hasta en la descripción canónica de un anticipo.
 */
const SERVICIO_TEXTO_RE =
  /\b(SERVICIO|MANTENIMIENTO|REPARACI[OÓ]N|MANO DE OBRA|LAVADO|AFINACI[OÓ]N|ALINEACI[OÓ]N|BALANCEO|DIAGN[OÓ]STICO|HOJALATER[IÍ]A|PINTURA)\b/i;

/**
 * Identificadores genéricos que los emisores ponen en NoIdentificacion sin que
 * sean partes. Sin este filtro, «MANO DE OBRA» como número de parte entraría al
 * kardex como una refacción llamada «MANO DE OBRA».
 */
const NO_IDENT_RUIDO = new Set([
  "TRASLADO", "SEGURO", "FLETE", "SERVICIO", "MO", "MANO DE OBRA", "N/A",
  "NA", "S/N", "SN", "GENERICO", "VARIOS", "01010101",
]);

/** True si el NoIdentificacion parece un número de parte de verdad. */
export function esNumeroDeParte(noIdent: string | null | undefined): boolean {
  const v = noIdent?.trim();
  if (!v || v.length < 2 || v.length > 40) return false;
  return !NO_IDENT_RUIDO.has(v.toUpperCase());
}

export interface ConceptoCfdi {
  claveProdServ?: string | null;
  noIdentificacion?: string | null;
  descripcion?: string | null;
}

export function clasificarConcepto(c: ConceptoCfdi): LineaConcepto {
  const clave = (c.claveProdServ ?? "").trim();
  const descripcion = c.descripcion ?? "";

  // 1. Anticipo: ni venta de taller ni refacción.
  if (clave === CLAVE_ANTICIPO || ANTICIPO_TEXTO_RE.test(descripcion)) return "NINGUNA";

  // 2. Clave autoritativa de taller.
  if (clave.startsWith(CLAVE_TALLER)) return "MANO_OBRA";

  // 3. Número de parte real bajo una clave que NO es de servicio.
  if (esNumeroDeParte(c.noIdentificacion) && !CLAVE_SERVICIO_RE.test(clave)) return "REFACCION";

  // 4. Último recurso: el texto.
  if (SERVICIO_TEXTO_RE.test(descripcion)) return "MANO_OBRA";

  return "NINGUNA";
}
