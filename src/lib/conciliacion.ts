import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Bank reconciliation helpers, shared by the web bancos page and the WhatsApp
// conciliación flow. Scoring mirrors /api/bancos/[id]/match (amount + date +
// RFC). Matching is a guided write — over WhatsApp it's gated by confirmation.
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_DAYS = 30;
const TOLERANCE = 0.05;

export interface MatchCandidate {
  invoiceId: string;
  uuid: string | null;
  fecha: string;
  total: number;
  tipo: string;
  cliente: string;
  rfc: string;
  metodoPago: string;
  score: number;
  confidence: "alta" | "media" | "baja";
}

/** Score candidate invoices for a single bank transaction. */
export async function scoreCandidates(txId: string, companyId: string): Promise<{
  tx: { id: string; fecha: string; descripcion: string; monto: number } | null;
  candidates: MatchCandidate[];
}> {
  const tx = await prisma.bankTransaction.findFirst({
    where: { id: txId, companyId },
  });
  if (!tx) return { tx: null, candidates: [] };

  const monto = Number(tx.monto);
  const absAmount = Math.abs(monto);
  // Incoming deposit → income CFDIs: INGRESO you issued, OR a NOMINA you
  // RECEIVED (asimilados/sueldos paid to you — a real income deposit).
  // Outgoing debit → expense CFDIs: EGRESO, OR a NOMINA you issued as employer.
  const incomingTypes = ["INGRESO", "NOMINA"] as const;
  const outgoingTypes = ["EGRESO", "NOMINA"] as const;
  const tipoIn = monto > 0 ? [...incomingTypes] : [...outgoingTypes];

  const invoices = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: { in: tipoIn },
      status: "STAMPED",
      fecha: {
        gte: new Date(tx.fecha.getTime() - WINDOW_DAYS * 86400000),
        lte: new Date(tx.fecha.getTime() + WINDOW_DAYS * 86400000),
      },
      total: { gte: absAmount * (1 - TOLERANCE), lte: absAmount * (1 + TOLERANCE) },
      // PUE ya cobrada no es candidata: ni por vínculo legado 1:1 ni por
      // porciones asignadas (conciliación múltiple, ConciliacionDetalle).
      OR: [
        { metodoPago: "PPD" },
        {
          bankTransactions: { none: { status: "MATCHED" } },
          conciliacionDetalles: { none: {} },
        },
      ],
    },
    include: { customer: { select: { rfc: true, razonSocial: true } } },
    orderBy: { fecha: "desc" },
    take: 10,
  });

  const candidates: MatchCandidate[] = invoices
    .map((inv) => {
      let score = 0;
      const total = Number(inv.total);
      const diff = Math.abs(Math.abs(total) - absAmount);
      if (diff < 0.01) score += 100;
      else if (diff / absAmount < 0.005) score += 70;
      else if (diff / absAmount < 0.01) score += 40;
      else if (diff / absAmount < TOLERANCE) score += 20;
      const daysDiff = Math.abs(inv.fecha.getTime() - tx.fecha.getTime()) / 86400000;
      if (daysDiff <= 1) score += 30;
      else if (daysDiff <= 3) score += 20;
      else if (daysDiff <= 7) score += 10;
      const rfc = inv.customer?.rfc ?? "";
      if (rfc && tx.descripcion.toUpperCase().includes(rfc)) score += 25;
      return {
        invoiceId: inv.id,
        uuid: inv.uuid,
        fecha: inv.fecha.toISOString().slice(0, 10),
        total,
        tipo: inv.tipo,
        cliente: inv.customer?.razonSocial ?? "—",
        rfc: inv.customer?.rfc ?? "—",
        metodoPago: inv.metodoPago,
        score,
        confidence: (score >= 100 ? "alta" : score >= 50 ? "media" : "baja") as MatchCandidate["confidence"],
      };
    })
    .sort((a, b) => b.score - a.score);

  return {
    tx: {
      id: tx.id,
      fecha: tx.fecha.toISOString().slice(0, 10),
      descripcion: tx.descripcion,
      monto,
    },
    candidates,
  };
}

export interface UnmatchedTx {
  id: string;
  fecha: string;
  descripcion: string;
  monto: number;
  banco: string;
  topCandidate: MatchCandidate | null;
}

/** List unmatched transactions for a company, each with its best candidate. */
export async function listUnmatched(companyId: string, limit = 10): Promise<{
  total: number;
  transactions: UnmatchedTx[];
}> {
  const total = await prisma.bankTransaction.count({
    where: { companyId, status: "UNMATCHED" },
  });
  const txs = await prisma.bankTransaction.findMany({
    where: { companyId, status: "UNMATCHED" },
    include: { bankAccount: { select: { banco: true } } },
    orderBy: { fecha: "desc" },
    take: limit,
  });

  const transactions: UnmatchedTx[] = [];
  for (const tx of txs) {
    const { candidates } = await scoreCandidates(tx.id, companyId);
    transactions.push({
      id: tx.id,
      fecha: tx.fecha.toISOString().slice(0, 10),
      descripcion: tx.descripcion,
      monto: Number(tx.monto),
      banco: tx.bankAccount?.banco ?? "—",
      topCandidate: candidates[0] ?? null,
    });
  }
  return { total, transactions };
}

export type ReconcileResult =
  | { ok: true; uuid: string | null; cliente: string }
  | { ok: false; error: string };

// ── Guard: una factura no debe quedar conciliada de más ──────────────────────
//
// Regla de negocio (aplicada en TODOS los caminos de escritura — PATCH manual,
// reconcileTransaction para WhatsApp/AI y el executor de acciones pendientes):
//   - PUE (pago en una sola exhibición): una factura ↔ UN evento de pago.
//     Un segundo match se rechaza. El pago puede ser una PORCIÓN de un
//     movimiento que cubre varias facturas (montoAsignado): sigue siendo
//     «una sola exhibición», pero entonces la porción debe cubrir el total
//     de la factura (±1%).
//   - PPD (pago en parcialidades): varios pagos son VÁLIDOS, pero el
//     acumulado (previos + nuevo) no debe exceder el total de la factura más
//     una tolerancia del 1% (redondeos). Cada pago cuenta por su porción
//     asignada si la tiene, o por el movimiento completo si es un match
//     legado 1:1.
// Los montos se comparan en valor absoluto y en las unidades en que están
// almacenados (misma convención que el scoring de candidatos: no se convierte
// moneda; Invoice.total y BankTransaction.monto se comparan directo).

/** Tolerancia sobre el total de la factura para el acumulado PPD (1%). */
export const PPD_ACUMULADO_TOLERANCIA = 0.01;

export type MatchGuardResult = { ok: true } | { ok: false; error: string };

/**
 * Un pago ya aplicado a la factura: un movimiento MATCHED completo (legado,
 * sin montoAsignado) o una porción asignada vía ConciliacionDetalle.
 */
export interface PagoConciliado {
  id: string;
  fecha: Date;
  monto: number;
  /** Porción del movimiento asignada a la factura; ausente = movimiento completo. */
  montoAsignado?: number;
}

function fmtMonto(n: number): string {
  return `$${Math.abs(n).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Monto con el que un pago cuenta para la factura (porción asignada o movimiento completo). */
function montoEfectivo(t: { monto: number; montoAsignado?: number }): number {
  return t.montoAsignado !== undefined ? Math.abs(t.montoAsignado) : Math.abs(t.monto);
}

/**
 * Une, para el guard, los movimientos MATCHED legados (vínculo 1:1) con las
 * porciones asignadas vía ConciliacionDetalle. Si un mismo movimiento aparece
 * en ambos lados (no debería), la porción asignada gana.
 */
export function mergePagosConciliados(
  matchedTxs: { id: string; fecha: Date; monto: number }[],
  detalles: { bankTransactionId: string; montoAsignado: number; bankTransaction: { fecha: Date; monto: number } }[],
): PagoConciliado[] {
  const porId = new Map<string, PagoConciliado>();
  for (const t of matchedTxs) porId.set(t.id, { id: t.id, fecha: t.fecha, monto: t.monto });
  for (const d of detalles) {
    porId.set(d.bankTransactionId, {
      id: d.bankTransactionId,
      fecha: d.bankTransaction.fecha,
      monto: d.bankTransaction.monto,
      montoAsignado: d.montoAsignado,
    });
  }
  return [...porId.values()];
}

/**
 * Decisión PURA: ¿puede conciliarse el pago `newTx` con esta factura, dado lo
 * ya conciliado? No toca la base de datos — el caller aporta la factura y sus
 * pagos previos (movimientos MATCHED legados + porciones asignadas; ver
 * mergePagosConciliados). Re-conciliar el MISMO movimiento es idempotente.
 * `newTx.montoAsignado` indica una conciliación múltiple: sólo esa porción
 * del movimiento se aplica a la factura.
 */
export function checkInvoiceMatchGuard(
  invoice: { metodoPago: string; total: number },
  matchedTxs: PagoConciliado[],
  newTx: { id: string; monto: number; montoAsignado?: number },
): MatchGuardResult {
  const previos = matchedTxs.filter((t) => t.id !== newTx.id);
  const total = Math.abs(invoice.total);

  // ── PUE: UNA EXHIBICIÓN NO ES UN SOLO VOUCHER ──────────────────────────
  //
  // La regla era «la porción debe cubrir el total»: un movimiento, completo, o
  // nada. Eso no describe cómo se cobra en un hospital. Medido en Haltus,
  // agosto 2026: la factura 1434 de $151,499.08 se pagó con CUATRO deslizadas
  // repartidas en tres afiliaciones, porque el paciente partió el pago entre
  // dos tarjetas y entre crédito y débito. Ninguna de las cuatro igualaba el
  // total, así que la regla rechazaba las cuatro — y con ella 32 de los 77
  // depósitos de terminal del mes, $1.07M que nadie podía conciliar.
  //
  // Partir el cobro en varias deslizadas NO lo vuelve pago en parcialidades:
  // sigue siendo una sola exhibición, un solo acto de pago. Lo que distingue a
  // PUE de PPD es lo que declara el CFDI y si necesita complemento, no cuántas
  // veces pasó la terminal. Esa distinción vive en el REP, no aquí.
  //
  // Lo que sí protege —y se conserva— es el techo: el acumulado nunca puede
  // pasar del total. Un segundo pago sobre una factura ya cubierta lo sigue
  // rechazando, porque el acumulado la excedería.
  //
  // Así que PUE y PPD comparten el mismo techo. Lo único que cambia es cómo se
  // explica el rechazo, porque el siguiente paso no es el mismo: en una PPD se
  // revisan las parcialidades ya aplicadas; en una PUE, si de verdad se está
  // cobrando en abonos, la factura debió emitirse como PPD.

  // Sin porción asignada y sin pagos previos se conserva el comportamiento
  // legado (el primer match 1:1 no valida monto contra total).
  // PPD, primer pago 1:1: no se valida el monto EXACTO —una parcialidad es
  // legítimamente menor que el total— pero sí que no lo EXCEDA. Un movimiento
  // mayor que la factura no es una parcialidad de nada; visto en producción,
  // un SPEI de $12,687.07 aplicado a una factura de $7,106.97.
  if (previos.length === 0 && newTx.montoAsignado === undefined) {
    const pago = montoEfectivo(newTx);
    if (pago > total * (1 + PPD_ACUMULADO_TOLERANCIA)) {
      return {
        ok: false,
        error:
          `El movimiento (${fmtMonto(pago)}) excede el total de la factura ` +
          `(${fmtMonto(invoice.total)}). Si cubre esta factura y algo más, use la ` +
          `conciliación múltiple para repartirlo.`,
      };
    }
    return { ok: true };
  }
  const acumulado = previos.reduce((s, t) => s + montoEfectivo(t), 0) + montoEfectivo(newTx);
  const limite = total * (1 + PPD_ACUMULADO_TOLERANCIA);
  if (acumulado > limite) {
    const esPpd = invoice.metodoPago === "PPD";
    return {
      ok: false,
      error:
        `El monto acumulado de los movimientos conciliados con esta factura ${esPpd ? "PPD" : "PUE"} ` +
        `(${fmtMonto(acumulado)}, incluyendo este movimiento) excedería el total ` +
        `de la factura (${fmtMonto(invoice.total)}). ` +
        (esPpd
          ? `Revise las parcialidades ya conciliadas.`
          : `Una PUE admite varias deslizadas de un mismo cobro, pero no más de su total: ` +
            `revise si sobra una o si la factura debió emitirse como PPD.`),
    };
  }
  return { ok: true };
}

// ── Conciliación múltiple: Σ de montos asignados vs monto del movimiento ─────

export type AdvertenciaSumaAsignada = {
  codigo: "SUMA_MENOR_AL_MOVIMIENTO";
  mensaje: string;
  montoMovimiento: number;
  sumaAsignada: number;
};

export type SumaAsignadaResult =
  | { ok: true; advertencia: AdvertenciaSumaAsignada | null }
  | { ok: false; error: string };

/**
 * Decisión PURA para conciliación múltiple: la suma de los montos asignados
 * no puede exceder el monto del movimiento (tolerancia 1%); quedar por debajo
 * se permite pero con advertencia (p. ej. comisión descontada o cobro parcial)
 * para que la UI/bitácora lo muestren.
 */
export function checkSumaAsignada(
  montoMovimiento: number,
  asignaciones: { monto: number }[],
): SumaAsignadaResult {
  const suma = asignaciones.reduce((s, a) => s + Math.abs(a.monto), 0);
  const absMonto = Math.abs(montoMovimiento);
  if (suma > absMonto * (1 + PPD_ACUMULADO_TOLERANCIA)) {
    return {
      ok: false,
      error:
        `La suma de los montos asignados (${fmtMonto(suma)}) excede el monto ` +
        `del movimiento (${fmtMonto(absMonto)}).`,
    };
  }
  if (suma < absMonto * (1 - PPD_ACUMULADO_TOLERANCIA)) {
    return {
      ok: true,
      advertencia: {
        codigo: "SUMA_MENOR_AL_MOVIMIENTO",
        mensaje:
          `La suma asignada (${fmtMonto(suma)}) es menor al monto del movimiento ` +
          `(${fmtMonto(absMonto)}); la diferencia quedó sin asignar.`,
        montoMovimiento: absMonto,
        sumaAsignada: suma,
      },
    };
  }
  return { ok: true, advertencia: null };
}

/** Persist a match: BankTransaction → Invoice (status MATCHED). */
export async function reconcileTransaction(
  txId: string,
  invoiceId: string,
  companyId: string
): Promise<ReconcileResult> {
  const [tx, inv] = await Promise.all([
    prisma.bankTransaction.findFirst({
      where: { id: txId, companyId },
      select: { id: true, monto: true },
    }),
    prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      select: {
        id: true,
        uuid: true,
        metodoPago: true,
        total: true,
        customer: { select: { razonSocial: true } },
        bankTransactions: {
          where: { status: "MATCHED" },
          select: { id: true, fecha: true, monto: true },
        },
        conciliacionDetalles: {
          select: {
            bankTransactionId: true,
            montoAsignado: true,
            bankTransaction: { select: { fecha: true, monto: true } },
          },
        },
      },
    }),
  ]);
  if (!tx) return { ok: false, error: "Movimiento no encontrado." };
  if (!inv) return { ok: false, error: "Factura no encontrada." };

  const pagosPrevios = mergePagosConciliados(
    inv.bankTransactions.map((t) => ({ ...t, monto: Number(t.monto) })),
    inv.conciliacionDetalles.map((d) => ({
      ...d,
      montoAsignado: Number(d.montoAsignado),
      bankTransaction: { ...d.bankTransaction, monto: Number(d.bankTransaction.monto) },
    })),
  );
  const guard = checkInvoiceMatchGuard({ ...inv, total: Number(inv.total) }, pagosPrevios, { ...tx, monto: Number(tx.monto) });
  if (!guard.ok) return { ok: false, error: guard.error };

  await prisma.bankTransaction.update({
    where: { id: txId },
    data: { status: "MATCHED", invoiceId },
  });
  return { ok: true, uuid: inv.uuid, cliente: inv.customer?.razonSocial ?? "—" };
}
