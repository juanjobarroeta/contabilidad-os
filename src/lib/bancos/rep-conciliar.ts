// ─────────────────────────────────────────────────────────────────────────────
// CONCILIAR POR REP — la respuesta ya está firmada, no hay que adivinarla.
//
// El complemento de pago (CFDI tipo P) dice, documento por documento, QUÉ
// facturas liquidó un pago y CUÁNTO se abonó a cada una. Cuando el proveedor lo
// emitió y lo tenemos sincronizado del SAT, conciliar deja de ser un problema
// de inferencia: el emisor ya declaró el desglose ante la autoridad.
//
// POR QUÉ IMPORTA MÁS QUE COMODIDAD. La póliza no depende de qué factura sea
// —un pago siempre es cargo a proveedores contra bancos— pero el IVA AL FLUJO
// (Art. 1-B) sí: `reclasificacionIvaFlujo` corre POR FACTURA, y cada una puede
// traer tasa distinta (16 %, 8 % frontera, 0 %, exenta) y retenciones. Un pago
// de $175,904.65 aplicado «a la cuenta» de un proveedor deja la contabilidad
// bien y el IVA adivinado. El REP lo resuelve al centavo.
//
// Medido en un hospital real: 97 de 235 movimientos pendientes tenían un REP
// que empata importe, RFC y fecha — entre ellos uno que liquida 21 facturas de
// un solo pago, justo el caso que ningún ranking por monto puede resolver.
//
// LÍMITE HONESTO: esto sirve sobre todo del lado de PAGOS. De los 2,036 REP de
// esa empresa, 1,758 los emitió el proveedor (pagos nuestros) y 273 los
// emitimos nosotros. Del lado de COBROS el REP normalmente es CONSECUENCIA de
// conciliar, no insumo — sólo ayuda cuando ya se emitió por fuera.
// ─────────────────────────────────────────────────────────────────────────────

/** Tolerancia del importe: el REP declara el pago al centavo, no se estira. */
export const TOLERANCIA_CENTAVOS = 0.01;
/** Días entre la fecha del pago declarada en el REP y la del movimiento. El
 *  REP se emite hasta el día 5 del mes siguiente, así que el desfase es normal. */
export const VENTANA_DIAS = 60;

export interface DoctoRep {
  /** Factura padre YA resuelta en la base (null si el CFDI no está). */
  invoiceId: string | null;
  uuid: string;
  impPagado: number;
  /** INGRESO (la emitimos: es un cobro) o EGRESO (la recibimos: es un pago). */
  tipoPadre: string | null;
}

/** Un `<pago:Pago>` del REP: un solo movimiento de dinero con su desglose. */
export interface PagoRep {
  repId: string;
  /** Fecha del pago SEGÚN EL REP — no la de emisión del comprobante. */
  fechaPago: Date;
  rfcContraparte: string | null;
  total: number;
  docs: DoctoRep[];
}

export interface MovimientoParaRep {
  fecha: Date;
  monto: number;
  contraparteRfc: string | null;
}

export type ResultadoEleccion =
  | { estado: "elegido"; pago: PagoRep }
  | { estado: "ambiguo"; pagos: PagoRep[] }
  | { estado: "sin_candidato" }
  | { estado: "incompleto"; pago: PagoRep; faltantes: string[] };

const mismoRfc = (a: string | null, b: string | null): boolean =>
  !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();

const diasEntre = (a: Date, b: Date): number =>
  Math.abs(a.getTime() - b.getTime()) / 86_400_000;

/**
 * ¿Qué pago del REP explica este movimiento? PURA.
 *
 * Un REP puede llevar VARIOS `<Pago>` (poco común pero existe: 2 de 2,036 en
 * la empresa medida), así que se decide contra cada pago por separado y no
 * contra la suma del comprobante entero — si no, un REP con dos pagos jamás
 * empataría con ninguno de los dos movimientos.
 *
 * Reglas, en orden de dureza:
 *   · el sentido tiene que coincidir — un retiro liquida facturas de EGRESO,
 *     un depósito cobra facturas de INGRESO;
 *   · el importe, al centavo;
 *   · el RFC, cuando el movimiento lo trae (si no lo trae, no descalifica: el
 *     estado de cuenta casi nunca lo imprime);
 *   · la fecha, dentro de la ventana.
 *
 * Ante la duda no se emite: si más de un pago cumple, se devuelve `ambiguo` y
 * no se aplica nada. Dos REP del mismo proveedor por el mismo importe existen
 * —parcialidades iguales— y elegir al azar sería inventar.
 */
export function elegirPagoRep(
  tx: MovimientoParaRep,
  pagos: PagoRep[],
  opts: { ventanaDias?: number } = {},
): ResultadoEleccion {
  const ventana = opts.ventanaDias ?? VENTANA_DIAS;
  const abs = Math.abs(tx.monto);
  const tipoEsperado = tx.monto < 0 ? "EGRESO" : "INGRESO";

  // SIN RFC, un importe redondo no identifica nada. El REP es autoridad sobre
  // SU desglose, pero ligar ESTE movimiento a ESE REP sigue siendo inferencia,
  // y con puro monto+fecha es débil: en la primera corrida real, un «TRASPASO
  // CUENTAS PROPIAS» de $40,000.00 empataba con un REP de $40,000.00, y diez
  // REP distintos empataban con cada movimiento de $10,000.00. Un importe con
  // centavos ($175,904.65) es una huella; uno redondo es una coincidencia
  // esperable. Con RFC no aplica esta regla: ahí la identidad ya respalda.
  const centavos = Math.round(Math.abs(tx.monto) * 100) % 100;
  if (!tx.contraparteRfc && centavos === 0) return { estado: "sin_candidato" };

  const viables = pagos.filter((p) => {
    if (p.docs.length === 0) return false;
    // El sentido lo decide la factura padre: un REP cuelga de facturas de un
    // solo tipo (medido: 0 mixtos de 2,036).
    const tipos = new Set(p.docs.map((d) => d.tipoPadre).filter(Boolean));
    if (tipos.size > 0 && !tipos.has(tipoEsperado)) return false;
    if (Math.abs(p.total - abs) > TOLERANCIA_CENTAVOS) return false;
    if (tx.contraparteRfc && !mismoRfc(tx.contraparteRfc, p.rfcContraparte)) return false;
    return diasEntre(p.fechaPago, tx.fecha) <= ventana;
  });

  if (viables.length === 0) return { estado: "sin_candidato" };
  if (viables.length > 1) return { estado: "ambiguo", pagos: viables };

  const pago = viables[0];
  // El REP nombra facturas que quizá no tengamos sincronizadas. Aplicar sólo
  // una parte del desglose repartiría mal el IVA, así que o está completo o no
  // se aplica: se reporta para que alguien traiga el CFDI que falta.
  const faltantes = pago.docs.filter((d) => !d.invoiceId).map((d) => d.uuid);
  if (faltantes.length > 0) return { estado: "incompleto", pago, faltantes };
  return { estado: "elegido", pago };
}

/**
 * Agrupa los documentos de un REP en pagos, por fecha de pago. PURA.
 *
 * `fechaPago` es la fecha LEGAL del pago (la que causa el IVA), distinta de la
 * fecha de emisión del comprobante. Cuando falta —complementos viejos mal
 * formados— se cae a la del REP para no perder el desglose entero.
 */
export function agruparPagos(
  rep: { id: string; fecha: Date; rfcContraparte: string | null },
  docs: Array<{ uuid: string; impPagado: number; fechaPago: Date | null; invoiceId: string | null; tipoPadre: string | null }>,
): PagoRep[] {
  const porFecha = new Map<string, typeof docs>();
  for (const d of docs) {
    const clave = (d.fechaPago ?? rep.fecha).toISOString();
    const g = porFecha.get(clave) ?? [];
    g.push(d);
    porFecha.set(clave, g);
  }
  return [...porFecha.entries()].map(([clave, g]) => ({
    repId: rep.id,
    fechaPago: new Date(clave),
    rfcContraparte: rep.rfcContraparte,
    total: Math.round(g.reduce((s, d) => s + d.impPagado, 0) * 100) / 100,
    docs: g.map((d) => ({ invoiceId: d.invoiceId, uuid: d.uuid, impPagado: d.impPagado, tipoPadre: d.tipoPadre })),
  }));
}
