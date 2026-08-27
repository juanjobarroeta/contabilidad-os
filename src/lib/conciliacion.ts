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

  if (invoice.metodoPago !== "PPD") {
    if (previos.length > 0) {
      // PUE: ya existe un pago aplicado → rechazar el segundo.
      const prev = previos[0];
      return {
        ok: false,
        error:
          `La factura ya está conciliada con otro movimiento bancario ` +
          `(${prev.fecha.toISOString().slice(0, 10)}, ${fmtMonto(montoEfectivo(prev))}). ` +
          `Una factura PUE sólo puede conciliarse con un movimiento; ` +
          `desvincule el movimiento anterior si desea corregir la conciliación.`,
      };
    }
    // Porción asignada (conciliación múltiple): PUE es «una sola exhibición»,
    // así que la porción debe cubrir el total de la factura (±1%). Pagarla
    // junto con otras facturas en una misma transferencia es válido; lo que
    // sigue prohibido es un segundo pago encima (caso anterior).
    if (newTx.montoAsignado !== undefined) {
      const asignado = Math.abs(newTx.montoAsignado);
      if (Math.abs(asignado - total) > total * PPD_ACUMULADO_TOLERANCIA) {
        return {
          ok: false,
          error:
            `El monto asignado (${fmtMonto(asignado)}) no coincide con el total de la ` +
            `factura PUE (${fmtMonto(total)}). Una factura PUE se paga en una sola ` +
            `exhibición: la porción asignada debe cubrir el total (tolerancia 1%).`,
        };
      }
    }
    return { ok: true };
  }

  // PPD: permitir parcialidades mientras el acumulado no exceda el total.
  // Sin porción asignada y sin pagos previos se conserva el comportamiento
  // legado (el primer match 1:1 no valida monto contra total).
  if (previos.length === 0 && newTx.montoAsignado === undefined) return { ok: true };
  const acumulado = previos.reduce((s, t) => s + montoEfectivo(t), 0) + montoEfectivo(newTx);
  const limite = total * (1 + PPD_ACUMULADO_TOLERANCIA);
  if (acumulado > limite) {
    return {
      ok: false,
      error:
        `El monto acumulado de los movimientos conciliados con esta factura PPD ` +
        `(${fmtMonto(acumulado)}, incluyendo este movimiento) excedería el total ` +
        `de la factura (${fmtMonto(invoice.total)}). Revise las parcialidades ya conciliadas.`,
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
