// ─────────────────────────────────────────────────────────────────────────────
// LO QUE SE LE PUEDE PEDIR AL CLIENTE. Sin Node: lo importa la mesa, no sólo el
// servidor.
//
// Cada tipo trae TRES cosas y las tres importan:
//
//   · el título, que es como se nombra el pedido en la app;
//   · QUÉ PEDIR exactamente, en palabras que el cliente entienda sin saber
//     contabilidad — «el estado de cuenta de la terminal» no le dice nada a
//     quien nunca lo ha descargado; «el reporte mensual que te manda el banco
//     por las ventas con tarjeta» sí;
//   · PARA QUÉ, porque un pedido sin motivo se ignora y uno con motivo se
//     atiende. Es la diferencia entre «falta un documento» y «sin esto no
//     puedo cuadrar tus ventas con tarjeta de septiembre».
// ─────────────────────────────────────────────────────────────────────────────

export type TipoSolicitud =
  | "estado_cuenta_terminal"
  | "voucher_terminal"
  | "estado_cuenta_banco"
  | "comprobante"
  | "aclaracion"
  | "documento_fiscal"
  | "decision";

export type EstadoSolicitud = "abierta" | "recibida" | "cancelada";
export type OrigenSolicitud = "motor" | "agente" | "usuario";

export const TIPOS_SOLICITUD: readonly TipoSolicitud[] = [
  "estado_cuenta_terminal",
  "voucher_terminal",
  "estado_cuenta_banco",
  "comprobante",
  "documento_fiscal",
  "aclaracion",
  "decision",
] as const;

export interface FichaTipo {
  titulo: string;
  /** Qué se le pide, dicho para el cliente. */
  quePedir: string;
  /** Para qué hace falta. Un pedido sin porqué no se atiende. */
  paraQue: string;
}

export const FICHA_TIPO: Record<TipoSolicitud, FichaTipo> = {
  estado_cuenta_terminal: {
    titulo: "Estado de cuenta de la terminal",
    quePedir:
      "el reporte mensual que te manda el banco por las ventas con tarjeta (el de la terminal, no el de la cuenta)",
    paraQue:
      "sin él no se puede cuadrar lo que el banco depositó contra las ventas del mes ni verificar las comisiones que te cobró",
  },
  voucher_terminal: {
    titulo: "Vouchers de la terminal",
    quePedir: "la foto de los vouchers de las ventas con tarjeta del día",
    paraQue:
      "el voucher dice a qué venta corresponde cada deslizada, y es el único momento en que alguien lo sabe con certeza",
  },
  estado_cuenta_banco: {
    titulo: "Estado de cuenta bancario",
    quePedir: "el estado de cuenta del banco del mes",
    paraQue: "sin él no hay movimientos que conciliar y el mes no se puede cerrar",
  },
  comprobante: {
    titulo: "Comprobante del gasto",
    quePedir: "la factura o el comprobante de este gasto",
    paraQue: "sin CFDI el gasto no es deducible y el IVA no se puede acreditar",
  },
  documento_fiscal: {
    titulo: "Documento fiscal",
    quePedir: "el acuse o documento que pide el SAT",
    paraQue: "hace falta para sostener lo declarado si el SAT lo revisa",
  },
  aclaracion: {
    titulo: "Aclaración",
    quePedir: "que nos digas de qué se trata este movimiento",
    paraQue: "no se puede clasificar algo cuyo origen nadie conoce, y adivinar lo deja mal registrado",
  },
  decision: {
    titulo: "Decisión",
    quePedir: "que decidas cómo quieres que se trate esto",
    paraQue: "es una decisión del contribuyente, no del contador: hay más de un camino defendible",
  },
};

export const TITULO_ESTADO: Record<EstadoSolicitud, string> = {
  abierta: "Pendiente de recibir",
  recibida: "Recibida",
  cancelada: "Cancelada",
};

/** Orden de atención: lo que bloquea el cierre antes que lo que sólo informa. */
export const ORDEN_TIPO: readonly TipoSolicitud[] = [
  "estado_cuenta_banco",
  "estado_cuenta_terminal",
  "voucher_terminal",
  "documento_fiscal",
  "comprobante",
  "aclaracion",
  "decision",
] as const;

export function esTipoSolicitud(v: unknown): v is TipoSolicitud {
  return typeof v === "string" && (TIPOS_SOLICITUD as readonly string[]).includes(v);
}

export function esEstadoSolicitud(v: unknown): v is EstadoSolicitud {
  return v === "abierta" || v === "recibida" || v === "cancelada";
}

/** El título de un tipo, o el tipo mismo si es uno que no conocemos. */
export function tituloDeTipo(tipo: string): string {
  return esTipoSolicitud(tipo) ? FICHA_TIPO[tipo].titulo : tipo;
}

/**
 * El pedido redactado. PURA.
 *
 * Junta el «qué» y el «para qué» en una frase; el motivo específico del caso,
 * cuando lo hay, va al final porque es el detalle y no el encabezado.
 */
export function redactarPedido(tipo: TipoSolicitud, opts: { periodo?: string | null; detalle?: string | null } = {}): string {
  const f = FICHA_TIPO[tipo];
  const cuando = opts.periodo ? ` de ${etiquetaPeriodo(opts.periodo)}` : "";
  const base = `Necesitamos ${f.quePedir}${cuando}: ${f.paraQue}.`;
  return opts.detalle ? `${base} ${opts.detalle}` : base;
}

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** "2026-09" → "septiembre de 2026". PURA. */
export function etiquetaPeriodo(periodo: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(periodo);
  if (!m) return periodo;
  const mes = MESES[Number(m[2]) - 1];
  return mes ? `${mes} de ${m[1]}` : periodo;
}
