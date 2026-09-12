// ─────────────────────────────────────────────────────────────────────────────
// APLICACIONES — la relación movimiento ↔ factura como UNA entidad de lectura.
//
// Hoy la misma fila de ConciliacionDetalle se lee de tres formas distintas:
// el resolver la ve como «cruce» del movimiento, la lista de candidatos la
// suma como `matchedAmount` de la factura, y el estado de cuenta la vuelve a
// sumar por su cuenta. Tres sumas, tres oportunidades de discrepar, y ninguna
// contesta lo que el contador pregunta: ¿cuánto FALTA en este movimiento?,
// ¿cuánto queda DISPONIBLE en esta factura?, ¿qué REP ampara ESTE abono?
//
// Aquí vive la única definición. PURO: recibe filas ya consultadas (el repo
// está en aplicaciones-repo.ts) y decide. Dos vistas del mismo dato:
//
//   resumirMovimiento → original · asignado · restante · estado · aplicaciones
//   resumirFactura    → total · aplicado · disponible · estado · aplicaciones · REP
//
// El vínculo 1:1 legado (BankTransaction.invoiceId, status MATCHED) cuenta
// como una aplicación por el importe completo del movimiento — igual que lo
// trata el guard (mergePagosConciliados) y el cruce del resolver.
//
// El REP se empareja POR APLICACIÓN, no por factura: para cada abono se busca
// la línea <pago:DoctoRelacionado> de esa factura cuyo ImpPagado coincide al
// centavo y cuya FechaPago cae en la ventana del movimiento (la misma regla
// que rep-conciliar). Una línea de REP ampara UN abono. PUE no lleva REP.
// ─────────────────────────────────────────────────────────────────────────────

import { TOLERANCIA_CENTAVOS, VENTANA_DIAS } from "./rep-conciliar";

export type EstadoAplicacion = "SIN_APLICAR" | "PARCIAL" | "COMPLETO" | "CATEGORIZADO";

/** Un abono no llega a «completo» por un centavo de redondeo. */
export const TOLERANCIA_COMPLETO = TOLERANCIA_CENTAVOS;

const r2 = (n: number) => Math.round(n * 100) / 100;
const DIA_MS = 24 * 60 * 60 * 1000;

// ── Insumos (filas ya consultadas; sin Prisma) ─────────────────────────────

export interface FacturaLigera {
  id: string;
  uuid: string | null;
  serie: string | null;
  folio: string | null;
  fecha: Date;
  total: number;
  tipo: string;
  /** PUE | PPD — decide si un abono debe llevar REP. */
  metodoPago: string;
  contraparteNombre: string | null;
  contraparteRfc: string | null;
}

export interface CuentaLigera {
  id: string;
  banco: string;
  nombre: string;
  numeroCuenta: string;
}

export interface MovimientoLigero {
  id: string;
  fecha: Date;
  descripcion: string;
  /** Firmado: + depósito, − retiro. */
  monto: number;
  status: "UNMATCHED" | "MATCHED" | "IGNORED";
  cuenta: CuentaLigera;
  contraparteNombre: string | null;
  contraparteRfc: string | null;
  claveRastreo: string | null;
}

/** Una porción (ConciliacionDetalle) o el vínculo 1:1 legado. */
export interface PorcionCruda {
  /** ConciliacionDetalle.id, o null si viene del vínculo 1:1. */
  id: string | null;
  montoAsignado: number;
  /** ConciliacionDetalle.createdAt; el 1:1 no lo guarda. */
  createdAt: Date | null;
}

/** Una línea <pago:DoctoRelacionado> de un REP que apunta a la factura. */
export interface LineaRep {
  id: string;
  /** UUID del CFDI tipo P que la trae. */
  repUuid: string | null;
  numParcialidad: number | null;
  impPagado: number | null;
  impSaldoInsoluto: number | null;
  /** FechaPago del <pago:Pago>: la fecha LEGAL del cobro. */
  fechaPago: Date | null;
}

export interface CepLigero {
  estado: string | null;
  fechaOperacion: string | null;
  concepto: string | null;
  monto: number | null;
  ordenanteNombre: string | null;
  ordenanteRfc: string | null;
  ordenanteBanco: string | null;
  ordenanteCuenta: string | null;
  beneficiarioNombre: string | null;
  beneficiarioRfc: string | null;
  beneficiarioBanco: string | null;
  beneficiarioCuenta: string | null;
}

// ── Salida ─────────────────────────────────────────────────────────────────

export type RepAplicacion =
  | { estado: "AMPARADA"; repUuid: string | null; numParcialidad: number | null; impSaldoInsoluto: number | null; fechaPago: Date | null }
  | { estado: "SIN_REP" }
  /** PUE: se paga en una exhibición, no lleva complemento. */
  | { estado: "NO_APLICA" };

export interface AplicacionBase {
  /** ConciliacionDetalle.id, o "1:1:<txId>" para el vínculo legado. */
  id: string;
  origen: "PORCION" | "UNO_A_UNO";
  /** La porción, en positivo. */
  monto: number;
  /** Fecha del MOVIMIENTO: la fecha legal del cobro/pago (Art. 1-B). */
  fecha: Date;
  registro: { fecha: Date | null; userId: string | null };
  rep: RepAplicacion;
}

export interface AplicacionDeMovimiento extends AplicacionBase {
  factura: FacturaLigera;
}

export interface AplicacionDeFactura extends AplicacionBase {
  movimiento: MovimientoLigero;
}

export interface ResumenMovimiento {
  movimiento: MovimientoLigero;
  cep: CepLigero | null;
  /** |monto| */
  original: number;
  asignado: number;
  /** original − asignado, nunca negativo. */
  restante: number;
  estado: EstadoAplicacion;
  aplicaciones: AplicacionDeMovimiento[];
  /** Un egreso conciliado contra una declaración, no contra facturas. */
  impuesto: { id: string; etiqueta: string; status: string } | null;
}

export interface ResumenFactura {
  factura: FacturaLigera;
  total: number;
  aplicado: number;
  /** total − aplicado, nunca negativo. */
  disponible: number;
  estado: Exclude<EstadoAplicacion, "CATEGORIZADO">;
  aplicaciones: AplicacionDeFactura[];
  /** Lo que dicen los REP de esta factura, se hayan emparejado o no. */
  rep: {
    lineas: number;
    amparado: number;
    ultimaParcialidad: number | null;
    saldoInsoluto: number | null;
  };
}

// ── Decisiones puras ───────────────────────────────────────────────────────

/** Estado de un movimiento según lo aplicado. */
export function estadoDeMovimiento(
  status: MovimientoLigero["status"],
  original: number,
  asignado: number,
  tieneImpuesto = false,
): EstadoAplicacion {
  if (tieneImpuesto) return "COMPLETO";
  if (asignado <= TOLERANCIA_COMPLETO) return status === "IGNORED" ? "CATEGORIZADO" : "SIN_APLICAR";
  return asignado >= original - TOLERANCIA_COMPLETO ? "COMPLETO" : "PARCIAL";
}

/** Estado de una factura según lo aplicado. */
export function estadoDeFactura(total: number, aplicado: number): ResumenFactura["estado"] {
  if (aplicado <= TOLERANCIA_COMPLETO) return "SIN_APLICAR";
  return aplicado >= total - TOLERANCIA_COMPLETO ? "COMPLETO" : "PARCIAL";
}

/**
 * Empareja UN abono con la línea de REP que lo ampara: mismo importe al centavo
 * y FechaPago dentro de la ventana del movimiento; si varias cumplen, la de
 * fecha más cercana. Muta `usadas` para que una línea ampare un solo abono.
 */
export function emparejarRep(
  abono: { monto: number; fecha: Date },
  metodoPago: string,
  lineas: LineaRep[],
  usadas: Set<string>,
  ventanaDias = VENTANA_DIAS,
): RepAplicacion {
  if (metodoPago === "PUE") return { estado: "NO_APLICA" };
  let mejor: { linea: LineaRep; dias: number } | null = null;
  for (const l of lineas) {
    if (usadas.has(l.id)) continue;
    if (l.impPagado == null || Math.abs(l.impPagado - abono.monto) > TOLERANCIA_CENTAVOS) continue;
    const dias = l.fechaPago ? Math.abs(l.fechaPago.getTime() - abono.fecha.getTime()) / DIA_MS : Number.POSITIVE_INFINITY;
    if (dias > ventanaDias) continue;
    if (!mejor || dias < mejor.dias) mejor = { linea: l, dias };
  }
  if (!mejor) return { estado: "SIN_REP" };
  usadas.add(mejor.linea.id);
  const l = mejor.linea;
  return { estado: "AMPARADA", repUuid: l.repUuid, numParcialidad: l.numParcialidad, impSaldoInsoluto: l.impSaldoInsoluto, fechaPago: l.fechaPago };
}

/** Las porciones de un movimiento, o el 1:1 si no hay porciones (misma regla que el cruce del resolver). */
function porcionesEfectivas(monto: number, porciones: PorcionCruda[], unoAUno: boolean): PorcionCruda[] {
  if (porciones.length > 0) return porciones;
  if (unoAUno) return [{ id: null, montoAsignado: Math.abs(monto), createdAt: null }];
  return [];
}

export function resumirMovimiento(input: {
  movimiento: MovimientoLigero;
  cep: CepLigero | null;
  /** Factura del vínculo 1:1 legado (null si no hay). */
  facturaUnoAUno: FacturaLigera | null;
  porciones: Array<PorcionCruda & { factura: FacturaLigera }>;
  /** Líneas de REP por factura (uuid normalizado → líneas). */
  repsPorFactura: Map<string, LineaRep[]>;
  impuesto: { id: string; etiqueta: string; status: string } | null;
}): ResumenMovimiento {
  const m = input.movimiento;
  const original = r2(Math.abs(m.monto));
  const efectivas: Array<PorcionCruda & { factura: FacturaLigera }> =
    input.porciones.length > 0
      ? input.porciones
      : m.status === "MATCHED" && input.facturaUnoAUno
        ? [{ id: null, montoAsignado: original, createdAt: null, factura: input.facturaUnoAUno }]
        : [];

  const usadas = new Set<string>();
  const aplicaciones: AplicacionDeMovimiento[] = efectivas.map((p) => {
    const monto = r2(Math.abs(p.montoAsignado));
    const lineas = p.factura.uuid ? input.repsPorFactura.get(p.factura.uuid.toUpperCase()) ?? [] : [];
    return {
      id: p.id ?? `1:1:${m.id}`,
      origen: p.id ? "PORCION" : "UNO_A_UNO",
      monto,
      fecha: m.fecha,
      registro: { fecha: p.createdAt, userId: null },
      rep: emparejarRep({ monto, fecha: m.fecha }, p.factura.metodoPago, lineas, usadas),
      factura: p.factura,
    };
  });

  const asignado = r2(aplicaciones.reduce((s, a) => s + a.monto, 0));
  return {
    movimiento: m,
    cep: input.cep,
    original,
    asignado,
    restante: r2(Math.max(0, original - asignado)),
    estado: estadoDeMovimiento(m.status, original, asignado, input.impuesto != null),
    aplicaciones,
    impuesto: input.impuesto,
  };
}

export function resumirFactura(input: {
  factura: FacturaLigera;
  /** Movimientos MATCHED con vínculo 1:1 a esta factura. */
  unoAUno: MovimientoLigero[];
  porciones: Array<PorcionCruda & { movimiento: MovimientoLigero }>;
  lineasRep: LineaRep[];
}): ResumenFactura {
  const f = input.factura;
  const total = r2(Math.abs(f.total));

  // Mismo criterio que mergePagosConciliados: si un movimiento aparece en los
  // dos lados (no debería), la porción gana.
  const conPorcion = new Set(input.porciones.map((p) => p.movimiento.id));
  const crudas: Array<PorcionCruda & { movimiento: MovimientoLigero }> = [
    ...input.porciones,
    ...input.unoAUno
      .filter((t) => !conPorcion.has(t.id))
      .map((t) => ({ id: null, montoAsignado: Math.abs(t.monto), createdAt: null, movimiento: t })),
  ].sort((a, b) => a.movimiento.fecha.getTime() - b.movimiento.fecha.getTime());

  const usadas = new Set<string>();
  const aplicaciones: AplicacionDeFactura[] = crudas.map((p) => {
    const monto = r2(Math.abs(p.montoAsignado));
    return {
      id: p.id ?? `1:1:${p.movimiento.id}`,
      origen: p.id ? "PORCION" : "UNO_A_UNO",
      monto,
      fecha: p.movimiento.fecha,
      registro: { fecha: p.createdAt, userId: null },
      rep: emparejarRep({ monto, fecha: p.movimiento.fecha }, f.metodoPago, input.lineasRep, usadas),
      movimiento: p.movimiento,
    };
  });

  const aplicado = r2(aplicaciones.reduce((s, a) => s + a.monto, 0));
  const lineas = [...input.lineasRep].sort((a, b) => (a.numParcialidad ?? 0) - (b.numParcialidad ?? 0));
  const ultima = lineas.length > 0 ? lineas[lineas.length - 1] : null;
  return {
    factura: f,
    total,
    aplicado,
    disponible: r2(Math.max(0, total - aplicado)),
    estado: estadoDeFactura(total, aplicado),
    aplicaciones,
    rep: {
      lineas: lineas.length,
      amparado: r2(lineas.reduce((s, l) => s + (l.impPagado ?? 0), 0)),
      ultimaParcialidad: ultima?.numParcialidad ?? null,
      saldoInsoluto: ultima?.impSaldoInsoluto ?? null,
    },
  };
}
