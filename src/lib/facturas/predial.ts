// ─────────────────────────────────────────────────────────────────────────────
// Cuenta predial en el CFDI (arrendamiento de inmuebles).
//
// OJO con el nombre: la cuenta predial NO es un complemento. En CFDI 4.0 es un
// nodo HIJO del concepto — <cfdi:CuentaPredial Numero="..."/> dentro de
// <cfdi:Concepto> — así que no toca nada de la maquinaria de complementos
// (REP, nómina). Facturapi lo recibe como `property_tax_account` en la partida,
// y lo modela como ARREGLO porque un mismo concepto puede amparar varias
// cuentas catastrales (un arrendamiento sobre un inmueble con más de una).
//
// Módulo PURO: normalización y la heurística que decide cuándo AVISAR que
// falta. Nunca bloquea el timbrado — quien decide es el contribuyente, y una
// clave de arrendamiento sin cuenta predial es legítima en algunos casos
// (subarrendamiento, bienes no inscritos en catastro).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Familia del catálogo c_ClaveProdServ para «Alquiler y arrendamiento de
 * propiedades o edificaciones» (80131500-80131599): residencial, comercial e
 * industrial, terrenos, espacios de venta. Es la señal de que el concepto
 * ampara la renta de un inmueble.
 */
export const PREFIJO_CLAVE_ARRENDAMIENTO = "801315";

/** Longitud máxima que admite el atributo Numero de CuentaPredial en CFDI 4.0. */
export const MAX_LARGO_CUENTA_PREDIAL = 150;

/** ¿La clave del concepto corresponde a arrendamiento de inmuebles? */
export function esClaveArrendamiento(claveProdServ: string | null | undefined): boolean {
  return (claveProdServ ?? "").trim().startsWith(PREFIJO_CLAVE_ARRENDAMIENTO);
}

/**
 * Normaliza una cuenta predial capturada a mano: recorta y colapsa espacios
 * internos. NO toca guiones, diagonales ni ceros a la izquierda — el formato de
 * la cuenta catastral lo define cada municipio y no hay dígito verificador
 * universal, así que "limpiarla" más rompería cuentas válidas. Devuelve null
 * cuando queda vacía.
 */
export function normalizarCuentaPredial(valor: string | null | undefined): string | null {
  const limpio = (valor ?? "").trim().replace(/\s+/g, " ");
  return limpio.length > 0 ? limpio : null;
}

/** ¿La cuenta predial capturada cabe en el atributo del SAT? */
export function cuentaPredialValida(valor: string | null | undefined): boolean {
  const n = normalizarCuentaPredial(valor);
  return n !== null && n.length <= MAX_LARGO_CUENTA_PREDIAL;
}

/**
 * Aviso (no bloqueo) cuando un concepto de arrendamiento va sin cuenta predial.
 * Devuelve null si no hay nada que decir. Misma mecánica que la advertencia de
 * contradicción de IVA en el formulario: informa y deja decidir.
 */
export function avisoCuentaPredial(
  claveProdServ: string | null | undefined,
  cuentaPredial: string | null | undefined
): string | null {
  if (!esClaveArrendamiento(claveProdServ)) return null;
  if (normalizarCuentaPredial(cuentaPredial)) return null;
  return "Los CFDI de arrendamiento de inmuebles suelen requerir el número de cuenta predial del inmueble.";
}

/**
 * Extrae TODAS las cuentas prediales del cuerpo de un <cfdi:Concepto>. CFDI 4.0
 * permite varias por concepto, así que devuelve arreglo; para un concepto sin
 * el nodo (el caso normal) devuelve vacío.
 */
export function cuentasPredialesDeConcepto(cuerpoConcepto: string): string[] {
  const re = /<(?:[a-zA-Z0-9]+:)?CuentaPredial\b[^>]*?\bNumero="([^"]*)"/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(cuerpoConcepto)) !== null) {
    const n = normalizarCuentaPredial(m[1]);
    if (n) out.push(n);
  }
  return out;
}
