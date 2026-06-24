/**
 * Shared helpers for the PADEL module: reservation slot-conflict detection and
 * IVA splitting. Kept separate from the route handlers so both the staff and
 * member booking paths (and the validation script's logic) stay consistent.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { AuthzError } from "./authz";

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Throws AuthzError(409) if an active (non-cancelled) reservation already
 * overlaps [inicio, fin) on the same court. Two slots overlap when
 * existing.inicio < new.fin AND existing.fin > new.inicio. Pass excludeId when
 * re-checking during an update.
 */
export async function assertNoConflict(
  db: Db,
  args: {
    companyId: string;
    courtId: string;
    inicio: Date;
    fin: Date;
    excludeId?: string;
  }
): Promise<void> {
  const clash = await db.reservation.findFirst({
    where: {
      companyId: args.companyId,
      courtId: args.courtId,
      id: args.excludeId ? { not: args.excludeId } : undefined,
      estado: { not: "CANCELADA" },
      inicio: { lt: args.fin },
      fin: { gt: args.inicio },
    },
    select: { id: true },
  });
  if (clash) {
    throw new AuthzError(409, "La cancha ya está reservada en ese horario");
  }
}

/**
 * Splits an IVA-included total into { subtotal, iva } using the given rate
 * (0.16 = 16%). Court-rental prices shown to members are IVA-included, so the
 * charge step backs out the tax. Returns iva = 0 when rate <= 0. Rounds to
 * cents to avoid floating drift in the ledger.
 */
export function splitIvaIncluded(
  total: number,
  ivaRate: number
): { subtotal: number; iva: number } {
  if (!(ivaRate > 0) || !(total > 0)) {
    return { subtotal: round2(total), iva: 0 };
  }
  const subtotal = round2(total / (1 + ivaRate));
  const iva = round2(total - subtotal);
  return { subtotal, iva };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Human-readable slot label for ledger descriptions / Playtomic notes. */
export function slotLabel(courtNombre: string, inicio: Date): string {
  return `Renta ${courtNombre} — ${inicio.toISOString().slice(0, 16).replace("T", " ")}`;
}
