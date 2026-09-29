// ─────────────────────────────────────────────────────────────────────────────
// EL COBRO DE UNA FACTURA CANCELADA
//
// Cancelar un CFDI sólo cambiaba `Invoice.status`. El movimiento bancario que
// lo cobraba (o pagaba) se quedaba MATCHED contra la factura muerta, y como el
// estado de cuenta trae los cobros POR FACTURA, ese dinero desaparecía: el
// cliente pagó y su saldo no lo reflejaba, y el depósito nunca volvía a la mesa
// para ligarse a la factura que la sustituyó. Medido el 29-sep-2026: 2
// movimientos (18,325) en producción, ninguno con sustituta.
//
// Al cancelarse, el cobro:
//   • pasa a la SUSTITUTA (TipoRelacion 04) si existe y está vigente — es el
//     mismo dinero por la misma operación, refacturada;
//   • si no hay sustituta, VUELVE A LA MESA (UNMATCHED, sin factura) para que
//     una persona decida: puede ser un anticipo, otra factura, una devolución.
// Cada movimiento deja su decisión en DecisionMotor con la razón.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { registrarDecisiones, type EntradaDecision } from "@/lib/decisiones";
import { variantesUuid } from "@/lib/fiscal/uuid";

type Db = PrismaClient | Prisma.TransactionClient;

export interface CobrosDeCancelada {
  /** Movimientos (1:1 o porciones) que pasaron a la sustituta. */
  movidos: number;
  /** Movimientos que volvieron a la mesa. */
  liberados: number;
  /** Monto (valor absoluto) de lo movido o liberado. */
  monto: number;
  /** La factura que la sustituye, si la hay. */
  sustitutaId: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** La sustituta vigente de una factura cancelada: la marcada en `sustituidoPorUuid` o la que la relaciona con 04. */
export async function sustitutaDe(
  db: Db,
  inv: { companyId: string; uuid: string | null; tipo: string; sustituidoPorUuid: string | null },
): Promise<{ id: string; uuid: string | null } | null> {
  if (!inv.uuid) return null;
  if (inv.sustituidoPorUuid) {
    const s = await db.invoice.findFirst({
      where: { companyId: inv.companyId, uuid: { in: variantesUuid([inv.sustituidoPorUuid]) }, status: "STAMPED", tipo: inv.tipo as never },
      select: { id: true, uuid: true },
    });
    if (s) return s;
  }
  return db.invoice.findFirst({
    where: {
      companyId: inv.companyId,
      status: "STAMPED",
      tipo: inv.tipo as never,
      tipoRelacion: "04",
      cfdiRelacionadoUuid: { in: variantesUuid([inv.uuid]) },
    },
    select: { id: true, uuid: true },
    orderBy: { fecha: "asc" },
  });
}

/**
 * Mueve a la sustituta, o regresa a la mesa, todo lo que el banco tiene
 * conciliado contra `invoiceId` (ya cancelada). Idempotente: sin movimientos
 * ligados no hace nada.
 */
export async function liberarCobrosDeCancelada(db: Db, invoiceId: string): Promise<CobrosDeCancelada> {
  const res: CobrosDeCancelada = { movidos: 0, liberados: 0, monto: 0, sustitutaId: null };
  const inv = await db.invoice.findUnique({
    where: { id: invoiceId },
    select: { companyId: true, uuid: true, tipo: true, sustituidoPorUuid: true },
  });
  if (!inv) return res;

  const [directos, detalles] = await Promise.all([
    db.bankTransaction.findMany({
      where: { invoiceId, status: "MATCHED" },
      select: { id: true, monto: true },
    }),
    db.conciliacionDetalle.findMany({
      where: { invoiceId },
      select: { id: true, bankTransactionId: true, montoAsignado: true },
    }),
  ]);
  if (directos.length === 0 && detalles.length === 0) return res;

  const sust = await sustitutaDe(db, inv);
  res.sustitutaId = sust?.id ?? null;
  const decisiones: EntradaDecision[] = [];
  const uuid8 = (inv.uuid ?? invoiceId).slice(0, 8);
  const decidir = (txId: string, monto: number, movido: boolean) =>
    decisiones.push({
      companyId: inv.companyId,
      entidad: "BankTransaction",
      entidadId: txId,
      motor: "cancelacion-cfdi",
      motorVersion: "1",
      actor: "motor",
      accion: movido ? "mover" : "liberar",
      resultado: { invoiceCancelada: invoiceId, sustituta: sust?.id ?? null, monto: r2(monto) },
      razones: [
        {
          regla: movido ? "cfdi.cancelado-con-sustituta" : "cfdi.cancelado-sin-sustituta",
          detalle: movido
            ? `La factura ${uuid8} se canceló en el SAT; el cobro pasa a su sustituta ${(sust?.uuid ?? "").slice(0, 8)}.`
            : `La factura ${uuid8} se canceló en el SAT y no tiene sustituta: el movimiento vuelve a la mesa.`,
          candidatoId: sust?.id ?? invoiceId,
          candidatoTipo: "Invoice",
        },
      ],
      refs: [invoiceId, ...(sust ? [sust.id] : [])],
    });

  // 1:1 — el movimiento entero.
  for (const t of directos) {
    const monto = Math.abs(Number(t.monto));
    await db.bankTransaction.update({
      where: { id: t.id },
      data: sust ? { invoiceId: sust.id } : { invoiceId: null, status: "UNMATCHED" },
    });
    res.monto += monto;
    if (sust) res.movidos++;
    else res.liberados++;
    decidir(t.id, monto, !!sust);
  }

  // Porciones de un movimiento que pagaba varias facturas.
  const tocados = new Set<string>();
  for (const d of detalles) {
    const monto = Math.abs(Number(d.montoAsignado));
    if (sust) {
      const previa = await db.conciliacionDetalle.findFirst({
        where: { bankTransactionId: d.bankTransactionId, invoiceId: sust.id },
        select: { id: true, montoAsignado: true },
      });
      if (previa) {
        await db.conciliacionDetalle.update({
          where: { id: previa.id },
          data: { montoAsignado: r2(Number(previa.montoAsignado) + monto) },
        });
        await db.conciliacionDetalle.delete({ where: { id: d.id } });
      } else {
        await db.conciliacionDetalle.update({ where: { id: d.id }, data: { invoiceId: sust.id } });
      }
      res.movidos++;
    } else {
      await db.conciliacionDetalle.delete({ where: { id: d.id } });
      tocados.add(d.bankTransactionId);
      res.liberados++;
    }
    res.monto += monto;
    decidir(d.bankTransactionId, monto, !!sust);
  }

  // Un movimiento que se quedó sin ninguna porción ni factura vuelve a la mesa.
  for (const txId of tocados) {
    const quedan = await db.conciliacionDetalle.count({ where: { bankTransactionId: txId } });
    if (quedan === 0) {
      await db.bankTransaction.updateMany({
        where: { id: txId, invoiceId: null, status: "MATCHED" },
        data: { status: "UNMATCHED" },
      });
    }
  }

  res.monto = r2(res.monto);
  registrarDecisiones(decisiones);
  return res;
}
