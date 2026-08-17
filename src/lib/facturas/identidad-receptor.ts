// ─────────────────────────────────────────────────────────────────────────────
// Identidad fiscal del CLIENTE tomada de un CFDI timbrado.
//
// Un CFDI 4.0 timbrado ya pasó la validación del padrón del SAT: la tripleta
// RFC + Nombre + DomicilioFiscalReceptor tiene que coincidir con el registro
// del receptor o el PAC lo rechaza. Entonces los atributos del nodo Receptor
// NO son un dato más — son los datos EXACTOS del cliente ante el SAT. (El mismo
// razonamiento que ya usa nomina/receptor-xml.ts para los empleados.)
//
// Lo que había: las tres altas de Customer desde CFDI escribían
// `regimenFiscal: "616"` («Sin obligaciones fiscales», falso para casi
// cualquier negocio) y NUNCA el código postal. Después, al querer facturarle a
// ese cliente, faltaba el CP y se mandaba el de la PROPIA empresa emisora como
// domicilio del receptor — que el SAT rechaza, porque no cuadra la tripleta.
//
// DIRECCIÓN IMPORTANTE. Sólo sirve en las EMITIDAS:
//   • Emitida  → la contraparte es el RECEPTOR: CP y régimen exactos. ✅
//   • Recibida → la contraparte es el EMISOR: su nodo trae RegimenFiscal pero
//     NO trae código postal. `LugarExpedicion` es el lugar de expedición, que
//     legalmente no es su domicilio fiscal — llenar el CP con eso sería
//     adivinar, y un CP inventado rompe el timbrado igual que uno ausente.
//
// PURO.
// ─────────────────────────────────────────────────────────────────────────────

/** Régimen que las altas automáticas usaban como relleno. No es un dato real. */
export const REGIMEN_PLACEHOLDER = "616";

export interface ReceptorCfdi {
  rfcReceptor?: string | null;
  nombreReceptor?: string | null;
  domicilioFiscalReceptor?: string | null;
  regimenFiscalReceptor?: string | null;
}

export interface IdentidadFiscal {
  /** CP del domicilio fiscal (5 dígitos) o null. */
  codigoPostal: string | null;
  /** Clave de régimen del receptor, o null si no vino. */
  regimenFiscal: string | null;
}

/**
 * Identidad fiscal utilizable de un CFDI, según la dirección.
 *
 * @param esEmitida true cuando NOSOTROS emitimos (la contraparte es el receptor).
 */
export function identidadDesdeCfdi(cfdi: ReceptorCfdi, esEmitida: boolean): IdentidadFiscal {
  if (!esEmitida) return { codigoPostal: null, regimenFiscal: null };
  const cp = cfdi.domicilioFiscalReceptor?.trim() ?? "";
  const reg = cfdi.regimenFiscalReceptor?.trim() ?? "";
  return {
    codigoPostal: /^\d{5}$/.test(cp) ? cp : null,
    regimenFiscal: reg || null,
  };
}

/**
 * Régimen a guardar al dar de alta un cliente desde un CFDI.
 *
 * Orden: el del receptor (exacto, emitidas) → el del emisor (recibidas: es el
 * régimen real del proveedor) → el relleno, sólo si no hubo nada.
 */
export function regimenParaAlta(args: {
  esEmitida: boolean;
  regimenFiscalReceptor?: string | null;
  regimenEmisor?: string | null;
}): string {
  const propio = args.esEmitida ? args.regimenFiscalReceptor : args.regimenEmisor;
  return propio?.trim() || REGIMEN_PLACEHOLDER;
}

export interface ClienteFiscalActual {
  codigoPostal: string | null;
  regimenFiscal: string | null;
}

/**
 * Campos a ACTUALIZAR de un cliente ya existente con lo que trae un CFDI.
 *
 * Sólo rellena huecos y corrige el relleno: nunca pisa un dato capturado a
 * mano, porque el contador pudo haberlo corregido con la constancia en la mano
 * y su dato vale más que el de un CFDI viejo. Devuelve {} si no hay nada que
 * hacer, para no escribir en balde.
 */
export function parcheCliente(
  actual: ClienteFiscalActual,
  identidad: IdentidadFiscal
): { codigoPostal?: string; regimenFiscal?: string } {
  const parche: { codigoPostal?: string; regimenFiscal?: string } = {};
  if (!actual.codigoPostal && identidad.codigoPostal) {
    parche.codigoPostal = identidad.codigoPostal;
  }
  // El placeholder cuenta como hueco: es lo que escribieron las altas
  // automáticas, no una decisión de nadie.
  const regimenVacio = !actual.regimenFiscal || actual.regimenFiscal === REGIMEN_PLACEHOLDER;
  if (regimenVacio && identidad.regimenFiscal && identidad.regimenFiscal !== REGIMEN_PLACEHOLDER) {
    parche.regimenFiscal = identidad.regimenFiscal;
  }
  return parche;
}

/** ¿Al cliente le falta lo indispensable para poder facturarle en 4.0? */
export function faltaIdentidadParaFacturar(c: ClienteFiscalActual): boolean {
  return !c.codigoPostal || !c.regimenFiscal || c.regimenFiscal === REGIMEN_PLACEHOLDER;
}
