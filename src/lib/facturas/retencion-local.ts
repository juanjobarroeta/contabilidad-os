// ─────────────────────────────────────────────────────────────────────────────
// Retenciones LOCALES del CFDI (complemento ImpuestosLocales, «implocal»).
//
// El caso que la pide: el CINCO AL MILLAR — el 0.5% que las dependencias
// retienen sobre cada estimación de obra pública para inspección, vigilancia y
// control (Art. 191 de la Ley Federal de Derechos). No es un impuesto federal:
// no cabe en el nodo estándar <Retenciones>, que sólo admite ISR (001), IVA
// (002) e IEPS (003). Por eso viaja en el complemento implocal, como
// RetencionesLocales/ImpLocRetenido.
//
// DOS DECISIONES QUE CAMBIAN EL TOTAL:
//
//   1. La base es el SUBTOTAL del comprobante, no el total. El 5 al millar se
//      calcula sobre el importe contratado ANTES de IVA; hacerlo sobre el total
//      con IVA infla la retención un 16%.
//
//   2. Va CONSOLIDADO en un solo nodo, no uno por concepto. Se adjunta a la
//      PRIMERA partida con `base` = el subtotal completo. Repartirlo por
//      concepto produce varios RetencionesLocales y, con el redondeo a dos
//      decimales de cada uno, un total que no cuadra con el 0.5% del contrato.
//
// PURO.
// ─────────────────────────────────────────────────────────────────────────────

/** 5 al millar = 5/1000 = 0.5%. */
export const TASA_CINCO_AL_MILLAR = 0.005;

/** Nombre que aparece como ImpLocRetenido en el complemento. */
export const NOMBRE_CINCO_AL_MILLAR = "5 AL MILLAR";

/** El complemento acota el nombre del impuesto local. */
const MAX_NOMBRE = 20;

export interface RetencionLocal {
  type: string;
  rate: number;
  withholding: true;
  base: number;
}

export interface PartidaImporte {
  quantity: number;
  price: number;
}

/** Subtotal del comprobante: la base del 5 al millar (antes de IVA). */
export function subtotalDePartidas(items: readonly PartidaImporte[]): number {
  const s = items.reduce((acc, i) => acc + (i.quantity || 0) * (i.price || 0), 0);
  return Math.round(s * 100) / 100;
}

/** Importe retenido, a dos decimales. */
export function montoRetencionLocal(base: number, tasa: number): number {
  if (!(base > 0) || !(tasa > 0)) return 0;
  return Math.round(base * tasa * 100) / 100;
}

/**
 * El nodo de retención local a adjuntar, o null si no hay nada que retener.
 * Se devuelve UNO solo: quien lo aplica lo cuelga de la primera partida.
 */
export function nodoRetencionLocal(args: {
  subtotal: number;
  tasa?: number;
  nombre?: string;
}): RetencionLocal | null {
  const tasa = args.tasa ?? TASA_CINCO_AL_MILLAR;
  if (!(args.subtotal > 0) || !(tasa > 0)) return null;
  const nombre = (args.nombre ?? NOMBRE_CINCO_AL_MILLAR).trim().slice(0, MAX_NOMBRE);
  return {
    type: nombre || NOMBRE_CINCO_AL_MILLAR,
    rate: tasa,
    withholding: true,
    base: args.subtotal,
  };
}

export interface PartidaConProducto {
  quantity: number;
  product: { price: number; local_taxes?: RetencionLocal[] } & Record<string, unknown>;
}

/**
 * Adjunta la retención local consolidada a la PRIMERA partida.
 *
 * Devuelve las partidas tal cual si no aplica, para que el llamador no tenga
 * que ramificar. No muta la entrada.
 */
export function aplicarRetencionLocal<T extends PartidaConProducto>(
  items: readonly T[],
  opts: { activa: boolean; tasa?: number; nombre?: string }
): T[] {
  if (!opts.activa || items.length === 0) return [...items];

  const subtotal = subtotalDePartidas(
    items.map((i) => ({ quantity: i.quantity, price: i.product.price }))
  );
  const nodo = nodoRetencionLocal({ subtotal, tasa: opts.tasa, nombre: opts.nombre });
  if (!nodo) return [...items];

  return items.map((item, i) =>
    i === 0 ? { ...item, product: { ...item.product, local_taxes: [nodo] } } : item
  );
}
