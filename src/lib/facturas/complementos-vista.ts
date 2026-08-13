// ─────────────────────────────────────────────────────────────────────────────
// Lógica de presentación de complementos de pago (REP) — pura.
//
// Dos problemas reales de la pantalla de Facturas:
//
//   1. El detalle de una factura PPD decía "Emitir complemento de pago" aunque
//      el complemento YA se hubiera emitido — sin enlace al que existe y sin
//      distinguir "falta el primero", "va una parcialidad" y "ya está pagada".
//   2. Un REP no dice por sí solo si es EMITIDO o RECIBIDO: el comprobante es
//      tipo PAGO en ambas direcciones. La dirección se deriva de las facturas
//      que paga — si paga una factura nuestra (INGRESO) lo emitimos nosotros;
//      si paga una que nos emitieron (EGRESO) lo recibimos. Es el mismo criterio
//      que ya usan la DIOT y el motor de IVA en flujo.
// ─────────────────────────────────────────────────────────────────────────────

export type DireccionRep = "emitido" | "recibido";

/**
 * Dirección de un REP según el tipo de sus facturas relacionadas.
 * null = no se puede saber (ninguna factura relacionada está en el sistema).
 */
export function direccionRep(tiposDePadres: readonly string[]): DireccionRep | null {
  if (tiposDePadres.includes("INGRESO")) return "emitido";
  if (tiposDePadres.includes("EGRESO")) return "recibido";
  return null;
}

export interface EstadoRepFactura {
  /** ¿Ofrecer el botón de emitir? */
  emitible: boolean;
  /** Texto del botón (cuando emitible). */
  etiqueta: string;
  /** Nota de estado (cuando NO emitible o como contexto). */
  nota: string | null;
}

/**
 * Qué ofrecerle al usuario en el detalle de una factura PPD emitida, según lo
 * que ya existe. La regla que faltaba: "ya está pagada por completo" NO es un
 * estado desde el que se invita a emitir otro complemento.
 *
 * @param saldoInsoluto  Saldo pendiente de la factura (del último docto o
 *                       total − pagado).
 * @param nComplementos  REPs vigentes que ya la referencian.
 */
export function estadoRepFactura(saldoInsoluto: number, nComplementos: number): EstadoRepFactura {
  const CENTAVO = 0.01;
  if (saldoInsoluto <= CENTAVO) {
    return {
      emitible: false,
      etiqueta: "",
      nota:
        nComplementos > 0
          ? `Pagada por completo — ${nComplementos} complemento${nComplementos === 1 ? "" : "s"} emitido${nComplementos === 1 ? "" : "s"}.`
          : "Sin saldo pendiente.",
    };
  }
  if (nComplementos > 0) {
    return {
      emitible: true,
      etiqueta: `Emitir otro complemento (saldo ${formatoMxn(saldoInsoluto)})`,
      nota: `${nComplementos} complemento${nComplementos === 1 ? "" : "s"} emitido${nComplementos === 1 ? "" : "s"}; saldo pendiente ${formatoMxn(saldoInsoluto)}.`,
    };
  }
  return { emitible: true, etiqueta: "Emitir complemento de pago (REP)", nota: null };
}

function formatoMxn(n: number): string {
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

export interface DoctoDeRep {
  impPagado: number | null;
  ivaTrasladado: number | null;
  fechaPago: Date | string | null;
  numParcialidad: number | null;
}

export interface ResumenRep {
  monto: number;
  iva: number;
  /** La FechaPago más temprana — la que causa el IVA. */
  fechaPago: string | null;
  parcialidades: number[];
}

/** Totales de un REP a partir de sus doctos (el comprobante trae $0). */
export function resumenRep(doctos: readonly DoctoDeRep[]): ResumenRep {
  const fechas = doctos
    .map((d) => (d.fechaPago instanceof Date ? d.fechaPago.toISOString() : d.fechaPago))
    .filter((f): f is string => !!f)
    .sort();
  return {
    monto: doctos.reduce((s, d) => s + (d.impPagado ?? 0), 0),
    iva: doctos.reduce((s, d) => s + (d.ivaTrasladado ?? 0), 0),
    fechaPago: fechas[0] ?? null,
    parcialidades: [...new Set(doctos.map((d) => d.numParcialidad).filter((n): n is number => n != null))].sort(
      (a, b) => a - b
    ),
  };
}
