// ─────────────────────────────────────────────────────────────────────────────
// Contraparte de un CFDI para mostrar: el Customer cuando existe y, si no, lo
// que trae el propio comprobante.
//
// Por qué hace falta el respaldo: a público en general (XAXX010101000) y a
// extranjeros (XEXX010101000) NO se les crea Customer a propósito — un registro
// por cada comprador de mostrador ensuciaría el catálogo, y fusionarlos todos
// bajo un mismo "Público en general" falsearía la concentración de clientes que
// mide el score de crédito. Pero el nombre SÍ viene en el XML, así que se
// denormaliza en Invoice.contraparteNombre/contraparteRfc al importar.
//
// Puras: sin BD, testeables. Reciben cualquier objeto con esa forma.
// ─────────────────────────────────────────────────────────────────────────────

export interface ConContraparte {
  customer?: { razonSocial: string; rfc: string } | null;
  contraparteNombre?: string | null;
  contraparteRfc?: string | null;
}

/** RFC genérico de operaciones con el público en general (CFDI 4.0). */
export const RFC_PUBLICO_GENERAL = "XAXX010101000";
/** RFC genérico de residentes en el extranjero. */
export const RFC_EXTRANJERO = "XEXX010101000";

/** Nombre de la contraparte, o `vacio` (default "—") si el CFDI no lo trae. */
export function nombreContraparte(inv: ConContraparte, vacio = "—"): string {
  const nombre = inv.customer?.razonSocial ?? inv.contraparteNombre;
  return nombre && nombre.trim() ? nombre : vacio;
}

/** RFC de la contraparte, o `vacio` (default "—") si el CFDI no lo trae. */
export function rfcContraparte(inv: ConContraparte, vacio = "—"): string {
  const rfc = inv.customer?.rfc ?? inv.contraparteRfc;
  return rfc && rfc.trim() ? rfc : vacio;
}

/** ¿La contraparte es el RFC genérico de público en general o extranjero?
 *  Útil para etiquetar en pantalla y para las reglas globales de la DIOT. */
export function esRfcGenerico(inv: ConContraparte): boolean {
  const rfc = rfcContraparte(inv, "");
  return rfc === RFC_PUBLICO_GENERAL || rfc === RFC_EXTRANJERO;
}
