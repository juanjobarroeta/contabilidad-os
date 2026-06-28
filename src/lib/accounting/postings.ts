/**
 * Accounting postings — single source of truth for how business events from
 * any product module turn into balanced double-entry rows in `AccountingEntry`.
 *
 * Rules every helper in this file must obey:
 *   1. Every event posts a balanced pair (DEBE = HABER) in one Prisma transaction.
 *   2. Every entry sets `fuente` (CFDI | NOMINA | BANCO | MANUAL | CONSTRUCCION | FLOTA)
 *      and `referenciaTipo` so we can drill back from a ledger row to its origin.
 *   3. Helpers accept a Prisma transaction client (`tx`) so they compose with the
 *      caller's transaction. Callers MUST wrap state-changing flows in
 *      `prisma.$transaction(async tx => { ... })`.
 *   4. Idempotency is the caller's job. The state machine on the source row
 *      (e.g. SolicitudCompra.estado) is what prevents double-posting.
 *   5. ChartAccount rows are auto-created on first use per company. This avoids
 *      forcing every customer to seed a chart of accounts before their first
 *      construction event.
 */

import type { AccountType, EntrySource, Prisma, PrismaClient } from "@prisma/client";

type Tx = Prisma.TransactionClient | PrismaClient;

/** Default chart of accounts entries the construction module touches. */
const DEFAULT_ACCOUNTS: Array<{
  cuentaSAT: string;
  nombre: string;
  tipo: AccountType;
}> = [
  { cuentaSAT: "1101", nombre: "Bancos",                tipo: "ACTIVO"  },
  { cuentaSAT: "1103", nombre: "Cuentas por cobrar",    tipo: "ACTIVO"  },
  { cuentaSAT: "1106", nombre: "Inventario de obra",    tipo: "ACTIVO"  },
  { cuentaSAT: "2102", nombre: "IVA trasladado",        tipo: "PASIVO"  },
  { cuentaSAT: "2104", nombre: "Acreedores diversos",   tipo: "PASIVO"  },
  { cuentaSAT: "2105", nombre: "Sueldos por pagar",     tipo: "PASIVO"  },
  { cuentaSAT: "2106", nombre: "IMSS por pagar",        tipo: "PASIVO"  },
  { cuentaSAT: "4101", nombre: "Ingresos por obra",     tipo: "INGRESO" },
  { cuentaSAT: "5101", nombre: "Costo de obra",         tipo: "COSTO"   },
  { cuentaSAT: "5102", nombre: "Mano de obra directa",  tipo: "COSTO"   },
  { cuentaSAT: "2103", nombre: "Anticipos de clientes", tipo: "PASIVO"  },
  // Padel module accounts (auto-created on first use per company).
  { cuentaSAT: "1100", nombre: "Caja",                  tipo: "ACTIVO"  },
  { cuentaSAT: "4150", nombre: "Ingresos por renta de cancha", tipo: "INGRESO" },
];

/**
 * Look up (or auto-create) a ChartAccount row for the given company + SAT code.
 * Cheap on the hot path: does one read, one write only on first use.
 */
export async function getOrCreateAccount(
  tx: Tx,
  companyId: string,
  cuentaSAT: string
): Promise<{ id: string }> {
  const existing = await tx.chartAccount.findFirst({
    where: { companyId, cuentaSAT, subcuenta: null },
    select: { id: true },
  });
  if (existing) return existing;

  const def = DEFAULT_ACCOUNTS.find((a) => a.cuentaSAT === cuentaSAT);
  if (!def) {
    throw new Error(
      `No default ChartAccount definition for SAT code ${cuentaSAT}. ` +
        `Add it to DEFAULT_ACCOUNTS in src/lib/accounting/postings.ts.`
    );
  }

  return tx.chartAccount.create({
    data: {
      companyId,
      cuentaSAT: def.cuentaSAT,
      nombre: def.nombre,
      tipo: def.tipo,
    },
    select: { id: true },
  });
}

export type PostingLeg = {
  /** SAT chart-of-accounts code, e.g. "1101" */
  cuentaSAT: string;
  /** Optional override; defaults to the entry-level descripcion */
  descripcion?: string;
};

export type PostBalancedEntryInput = {
  companyId: string;
  fecha: Date;
  descripcion: string;
  monto: number;
  fuente: EntrySource;
  referencia: string;
  referenciaTipo: string;
  cargo: PostingLeg;
  abono: PostingLeg;
};

/**
 * Posts a balanced (cargo / abono) pair. Throws if monto <= 0.
 *
 * IMPORTANT: This does NOT open a transaction — pass in `tx` from the caller's
 * `prisma.$transaction(async (tx) => { ... })` block so the postings commit or
 * roll back atomically with the source row mutation.
 */
export async function postBalancedEntry(
  tx: Tx,
  input: PostBalancedEntryInput
): Promise<void> {
  const { companyId, fecha, descripcion, monto, fuente, referencia, referenciaTipo, cargo, abono } = input;

  if (!(monto > 0)) {
    throw new Error(`postBalancedEntry: monto must be > 0, got ${monto}`);
  }
  if (cargo.cuentaSAT === abono.cuentaSAT) {
    throw new Error(`postBalancedEntry: cargo and abono accounts must differ`);
  }

  const [cargoAccount, abonoAccount] = await Promise.all([
    getOrCreateAccount(tx, companyId, cargo.cuentaSAT),
    getOrCreateAccount(tx, companyId, abono.cuentaSAT),
  ]);

  const year = fecha.getUTCFullYear();
  const month = fecha.getUTCMonth() + 1;

  await tx.accountingEntry.createMany({
    data: [
      {
        companyId,
        chartAccountId: cargoAccount.id,
        fecha,
        year,
        month,
        descripcion: cargo.descripcion ?? descripcion,
        referencia,
        referenciaTipo,
        monto,
        tipo: "CARGO",
        fuente,
      },
      {
        companyId,
        chartAccountId: abonoAccount.id,
        fecha,
        year,
        month,
        descripcion: abono.descripcion ?? descripcion,
        referencia,
        referenciaTipo,
        monto,
        tipo: "ABONO",
        fuente,
      },
    ],
  });
}

// ─── Construction-specific postings ──────────────────────────────────────────
//
// Each helper is a thin wrapper over `postBalancedEntry` that encodes the
// account mapping for one business event. Adding a new event = adding a new
// function here. Account choices follow standard Mexican GAAP.

/**
 * Solicitud de compra paid from a bank account.
 *   DR 5101 Costo de obra
 *   CR 1101 Bancos
 *
 * Amounts include IVA in v1 — IVA splitting will live in a separate helper
 * once we model the IVA on solicitudes (today they only carry a flat total).
 */
export async function postSolicitudCompraPaid(
  tx: Tx,
  args: {
    companyId: string;
    solicitudId: string;
    folio: string;
    monto: number;
    fecha: Date;
    proyectoCodigo?: string;
  }
): Promise<void> {
  const desc =
    `Pago solicitud ${args.folio}` +
    (args.proyectoCodigo ? ` — proyecto ${args.proyectoCodigo}` : "");

  await postBalancedEntry(tx, {
    companyId: args.companyId,
    fecha: args.fecha,
    descripcion: desc,
    monto: args.monto,
    fuente: "CONSTRUCCION",
    referencia: args.solicitudId,
    referenciaTipo: "SOLICITUD_COMPRA",
    cargo: { cuentaSAT: "5101" },
    abono: { cuentaSAT: "1101" },
  });
}

/**
 * Estimación timbrada → AR + revenue + IVA.
 *   DR 1103 CxC                (= total con IVA)
 *   CR 4101 Ingresos por obra  (= subtotal sin IVA)
 *   CR 2102 IVA trasladado     (= iva)
 *
 * This is a 3-leg posting, so we use two paired calls to keep it balanced
 * (total CARGO across calls = total ABONO).
 */
export async function postEstimacionTimbrada(
  tx: Tx,
  args: {
    companyId: string;
    estimacionId: string;
    numero: number;
    proyectoCodigo: string;
    subtotal: number;
    iva: number;
    fecha: Date;
  }
): Promise<void> {
  const desc = `Estimación #${args.numero} — ${args.proyectoCodigo}`;
  const total = args.subtotal + args.iva;
  const year = args.fecha.getUTCFullYear();
  const month = args.fecha.getUTCMonth() + 1;

  // Single transaction-friendly approach: emit 3 lines directly so totals are
  // exact. We bypass postBalancedEntry to avoid two reconciling calls.
  const [cxc, ingresos, iva] = await Promise.all([
    getOrCreateAccount(tx, args.companyId, "1103"),
    getOrCreateAccount(tx, args.companyId, "4101"),
    getOrCreateAccount(tx, args.companyId, "2102"),
  ]);

  await tx.accountingEntry.createMany({
    data: [
      {
        companyId: args.companyId,
        chartAccountId: cxc.id,
        fecha: args.fecha,
        year,
        month,
        descripcion: desc,
        referencia: args.estimacionId,
        referenciaTipo: "ESTIMACION",
        monto: total,
        tipo: "CARGO",
        fuente: "CONSTRUCCION",
      },
      {
        companyId: args.companyId,
        chartAccountId: ingresos.id,
        fecha: args.fecha,
        year,
        month,
        descripcion: desc,
        referencia: args.estimacionId,
        referenciaTipo: "ESTIMACION",
        monto: args.subtotal,
        tipo: "ABONO",
        fuente: "CONSTRUCCION",
      },
      {
        companyId: args.companyId,
        chartAccountId: iva.id,
        fecha: args.fecha,
        year,
        month,
        descripcion: desc,
        referencia: args.estimacionId,
        referenciaTipo: "ESTIMACION",
        monto: args.iva,
        tipo: "ABONO",
        fuente: "CONSTRUCCION",
      },
    ],
  });
}

/**
 * Anticipo received from a construction client.
 *   DR 1101 Bancos
 *   CR 2103 Anticipos de clientes
 *
 * The anticipo creates a liability (Anticipos de clientes) that is
 * amortized proportionally against each estimación during the project.
 */
export async function postAnticipoRecibido(
  tx: Tx,
  args: {
    companyId: string;
    proyectoId: string;
    proyectoCodigo: string;
    monto: number;
    fecha: Date;
  }
): Promise<void> {
  await postBalancedEntry(tx, {
    companyId: args.companyId,
    fecha: args.fecha,
    descripcion: `Anticipo recibido — proyecto ${args.proyectoCodigo}`,
    monto: args.monto,
    fuente: "CONSTRUCCION",
    referencia: args.proyectoId,
    referenciaTipo: "ANTICIPO_PROYECTO",
    cargo: { cuentaSAT: "1101" },
    abono: { cuentaSAT: "2103" },
  });
}

/**
 * Amortización de anticipo against an estimación.
 *   DR 2103 Anticipos de clientes
 *   CR 1103 Cuentas por cobrar
 *
 * Each estimación amortizes a proportional share of the original anticipo.
 * Reduces both the liability and the receivable.
 */
export async function postAnticipoAmortizacion(
  tx: Tx,
  args: {
    companyId: string;
    estimacionId: string;
    proyectoCodigo: string;
    numero: number;
    monto: number;
    fecha: Date;
  }
): Promise<void> {
  await postBalancedEntry(tx, {
    companyId: args.companyId,
    fecha: args.fecha,
    descripcion: `Amortización anticipo — estimación #${args.numero} ${args.proyectoCodigo}`,
    monto: args.monto,
    fuente: "CONSTRUCCION",
    referencia: args.estimacionId,
    referenciaTipo: "ANTICIPO_AMORTIZACION",
    cargo: { cuentaSAT: "2103" },
    abono: { cuentaSAT: "1103" },
  });
}

// ─── Padel-specific postings ─────────────────────────────────────────────────
//
// Court-rental (and academy/shop in later milestones) revenue collected at the
// front desk or via the member app. Account mapping by forma de pago:
//   EFECTIVO       → DR 1100 Caja
//   TRANSFERENCIA  → DR 1101 Bancos
//   TARJETA        → DR 1101 Bancos
//   CUENTA         → DR 1103 Cuentas por cobrar (on account)
// Credit legs: CR 4150 Ingresos por renta de cancha (subtotal) + CR 2102 IVA
// trasladado (iva, when > 0). CORTESIA (comp) posts nothing — the caller skips.

export type PadelFormaPago = "EFECTIVO" | "TRANSFERENCIA" | "TARJETA" | "CUENTA";

function cargoAccountForFormaPago(formaPago: PadelFormaPago): string {
  switch (formaPago) {
    case "EFECTIVO":
      return "1100"; // Caja
    case "TRANSFERENCIA":
    case "TARJETA":
      return "1101"; // Bancos
    case "CUENTA":
      return "1103"; // Cuentas por cobrar
  }
}

/**
 * Court-rental revenue collected.
 *   DR <cargo by formaPago>   (= subtotal + iva)
 *   CR 4150 Ingresos por renta de cancha   (= subtotal)
 *   CR 2102 IVA trasladado                 (= iva, only when iva > 0)
 *
 * When iva is 0 this is a balanced 2-leg pair (via postBalancedEntry); when iva
 * is present it's a 3-leg posting emitted directly (mirrors postEstimacionTimbrada).
 */
export async function postCourtRentalRevenue(
  tx: Tx,
  args: {
    companyId: string;
    reservationId: string;
    descripcion: string; // e.g. "Renta Cancha 1 — 2026-06-24 18:00"
    subtotal: number;
    iva: number;
    formaPago: PadelFormaPago;
    fecha: Date;
  }
): Promise<void> {
  const cargoSAT = cargoAccountForFormaPago(args.formaPago);

  if (!(args.iva > 0)) {
    await postBalancedEntry(tx, {
      companyId: args.companyId,
      fecha: args.fecha,
      descripcion: args.descripcion,
      monto: args.subtotal,
      fuente: "PADEL",
      referencia: args.reservationId,
      referenciaTipo: "RESERVATION_CHARGE",
      cargo: { cuentaSAT: cargoSAT },
      abono: { cuentaSAT: "4150" },
    });
    return;
  }

  const total = args.subtotal + args.iva;
  const year = args.fecha.getUTCFullYear();
  const month = args.fecha.getUTCMonth() + 1;

  const [cargo, ingresos, iva] = await Promise.all([
    getOrCreateAccount(tx, args.companyId, cargoSAT),
    getOrCreateAccount(tx, args.companyId, "4150"),
    getOrCreateAccount(tx, args.companyId, "2102"),
  ]);

  await tx.accountingEntry.createMany({
    data: [
      {
        companyId: args.companyId,
        chartAccountId: cargo.id,
        fecha: args.fecha,
        year,
        month,
        descripcion: args.descripcion,
        referencia: args.reservationId,
        referenciaTipo: "RESERVATION_CHARGE",
        monto: total,
        tipo: "CARGO",
        fuente: "PADEL",
      },
      {
        companyId: args.companyId,
        chartAccountId: ingresos.id,
        fecha: args.fecha,
        year,
        month,
        descripcion: args.descripcion,
        referencia: args.reservationId,
        referenciaTipo: "RESERVATION_CHARGE",
        monto: args.subtotal,
        tipo: "ABONO",
        fuente: "PADEL",
      },
      {
        companyId: args.companyId,
        chartAccountId: iva.id,
        fecha: args.fecha,
        year,
        month,
        descripcion: args.descripcion,
        referencia: args.reservationId,
        referenciaTipo: "RESERVATION_CHARGE",
        monto: args.iva,
        tipo: "ABONO",
        fuente: "PADEL",
      },
    ],
  });
}
