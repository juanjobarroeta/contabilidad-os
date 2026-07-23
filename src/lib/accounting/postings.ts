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
  // Restaurante module accounts (auto-created on first use per company).
  { cuentaSAT: "1107", nombre: "Almacén de insumos",              tipo: "ACTIVO"  },
  { cuentaSAT: "1118", nombre: "IVA acreditable",                 tipo: "ACTIVO"  },
  { cuentaSAT: "2107", nombre: "Propinas por pagar",              tipo: "PASIVO"  },
  { cuentaSAT: "4160", nombre: "Ingresos por alimentos y bebidas", tipo: "INGRESO" },
  { cuentaSAT: "5103", nombre: "Costo de alimentos y bebidas",    tipo: "COSTO"   },
  // Purificadora module accounts (auto-created on first use per company).
  { cuentaSAT: "4170", nombre: "Ingresos por venta de agua purificada", tipo: "INGRESO" },
  { cuentaSAT: "5203", nombre: "Gastos de operación purificadora",      tipo: "GASTO"   },
  // Automotriz module accounts (auto-created on first use per company).
  { cuentaSAT: "1115", nombre: "Inventario de vehículos",               tipo: "ACTIVO"  },
  { cuentaSAT: "2110", nombre: "ISAN por pagar",                        tipo: "PASIVO"  },
  { cuentaSAT: "4180", nombre: "Ingresos por venta de vehículos",       tipo: "INGRESO" },
  { cuentaSAT: "5110", nombre: "Costo de ventas de vehículos",          tipo: "COSTO"   },
  { cuentaSAT: "5205", nombre: "Intereses de plan piso",                tipo: "GASTO"   },
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

// ─── Restaurante-specific postings ───────────────────────────────────────────
//
// The RestauranteOS money loops. Purchases feed inventory (almacén) and
// payables; charged orders recognize revenue + IVA + tips and relieve
// inventory at theoretical (recipe) cost. Account mapping by forma de pago
// mirrors the padel module:
//   EFECTIVO       → 1100 Caja
//   TRANSFERENCIA  → 1101 Bancos
//   TARJETA        → 1101 Bancos

export type RestFormaPagoPosting = "EFECTIVO" | "TRANSFERENCIA" | "TARJETA";

function restCashAccountFor(formaPago: RestFormaPagoPosting): string {
  switch (formaPago) {
    case "EFECTIVO":
      return "1100"; // Caja
    case "TRANSFERENCIA":
    case "TARJETA":
      return "1101"; // Bancos
  }
}

/**
 * Compra de insumos RECIBIDA (goods received, not yet paid).
 *   DR 1107 Almacén de insumos   (= subtotal)
 *   DR 1118 IVA acreditable      (= iva, only when > 0 — many foodstuffs are 0%)
 *   CR 2104 Acreedores diversos  (= subtotal + iva)
 *
 * 2-leg via postBalancedEntry when iva = 0; otherwise a 3-leg posting emitted
 * directly (mirrors postEstimacionTimbrada). Fiscal IVA acreditación is
 * derived by the tax engine from CFDIs — this entry is the operational book.
 */
export async function postCompraRestauranteRecibida(
  tx: Tx,
  args: {
    companyId: string;
    compraId: string;
    folio: string;
    subtotal: number;
    iva: number;
    fecha: Date;
    proveedorNombre?: string;
  }
): Promise<void> {
  const desc =
    `Compra insumos ${args.folio}` +
    (args.proveedorNombre ? ` — ${args.proveedorNombre}` : "");

  if (!(args.iva > 0)) {
    await postBalancedEntry(tx, {
      companyId: args.companyId,
      fecha: args.fecha,
      descripcion: desc,
      monto: args.subtotal,
      fuente: "RESTAURANTE",
      referencia: args.compraId,
      referenciaTipo: "REST_COMPRA_RECIBIDA",
      cargo: { cuentaSAT: "1107" },
      abono: { cuentaSAT: "2104" },
    });
    return;
  }

  const total = args.subtotal + args.iva;
  const year = args.fecha.getUTCFullYear();
  const month = args.fecha.getUTCMonth() + 1;

  const [almacen, ivaAcred, acreedores] = await Promise.all([
    getOrCreateAccount(tx, args.companyId, "1107"),
    getOrCreateAccount(tx, args.companyId, "1118"),
    getOrCreateAccount(tx, args.companyId, "2104"),
  ]);

  await tx.accountingEntry.createMany({
    data: [
      {
        companyId: args.companyId,
        chartAccountId: almacen.id,
        fecha: args.fecha,
        year,
        month,
        descripcion: desc,
        referencia: args.compraId,
        referenciaTipo: "REST_COMPRA_RECIBIDA",
        monto: args.subtotal,
        tipo: "CARGO",
        fuente: "RESTAURANTE",
      },
      {
        companyId: args.companyId,
        chartAccountId: ivaAcred.id,
        fecha: args.fecha,
        year,
        month,
        descripcion: desc,
        referencia: args.compraId,
        referenciaTipo: "REST_COMPRA_RECIBIDA",
        monto: args.iva,
        tipo: "CARGO",
        fuente: "RESTAURANTE",
      },
      {
        companyId: args.companyId,
        chartAccountId: acreedores.id,
        fecha: args.fecha,
        year,
        month,
        descripcion: desc,
        referencia: args.compraId,
        referenciaTipo: "REST_COMPRA_RECIBIDA",
        monto: total,
        tipo: "ABONO",
        fuente: "RESTAURANTE",
      },
    ],
  });
}

/**
 * Compra de insumos PAGADA (settles the payable created at receipt).
 *   DR 2104 Acreedores diversos  (= total)
 *   CR 1100 Caja / 1101 Bancos   (= total, by forma de pago)
 */
export async function postCompraRestaurantePagada(
  tx: Tx,
  args: {
    companyId: string;
    compraId: string;
    folio: string;
    total: number;
    formaPago: RestFormaPagoPosting;
    fecha: Date;
    proveedorNombre?: string;
  }
): Promise<void> {
  const desc =
    `Pago compra insumos ${args.folio}` +
    (args.proveedorNombre ? ` — ${args.proveedorNombre}` : "");

  await postBalancedEntry(tx, {
    companyId: args.companyId,
    fecha: args.fecha,
    descripcion: desc,
    monto: args.total,
    fuente: "RESTAURANTE",
    referencia: args.compraId,
    referenciaTipo: "REST_COMPRA_PAGADA",
    cargo: { cuentaSAT: "2104" },
    abono: { cuentaSAT: restCashAccountFor(args.formaPago) },
  });
}

/**
 * Orden (comanda) cobrada — revenue side.
 *   DR 1100 Caja / 1101 Bancos            (= subtotal + iva + propina)
 *   CR 4160 Ingresos alimentos y bebidas  (= subtotal)
 *   CR 2102 IVA trasladado                (= iva, when > 0)
 *   CR 2107 Propinas por pagar            (= propina, when > 0 — NOT revenue)
 *
 * CORTESIA posts nothing — the caller skips this helper entirely.
 */
export async function postVentaRestaurante(
  tx: Tx,
  args: {
    companyId: string;
    ordenId: string;
    descripcion: string; // e.g. "Orden #123 — Mesa 4"
    subtotal: number;
    iva: number;
    propina: number;
    formaPago: RestFormaPagoPosting;
    fecha: Date;
  }
): Promise<void> {
  const totalCobrado = args.subtotal + args.iva + args.propina;
  if (!(totalCobrado > 0)) {
    throw new Error(`postVentaRestaurante: total must be > 0, got ${totalCobrado}`);
  }

  const year = args.fecha.getUTCFullYear();
  const month = args.fecha.getUTCMonth() + 1;

  const [cargo, ingresos, ivaTras, propinas] = await Promise.all([
    getOrCreateAccount(tx, args.companyId, restCashAccountFor(args.formaPago)),
    getOrCreateAccount(tx, args.companyId, "4160"),
    args.iva > 0 ? getOrCreateAccount(tx, args.companyId, "2102") : null,
    args.propina > 0 ? getOrCreateAccount(tx, args.companyId, "2107") : null,
  ]);

  const base = {
    companyId: args.companyId,
    fecha: args.fecha,
    year,
    month,
    descripcion: args.descripcion,
    referencia: args.ordenId,
    referenciaTipo: "REST_ORDEN_COBRADA",
    fuente: "RESTAURANTE" as EntrySource,
  };

  await tx.accountingEntry.createMany({
    data: [
      { ...base, chartAccountId: cargo.id, monto: totalCobrado, tipo: "CARGO" },
      { ...base, chartAccountId: ingresos.id, monto: args.subtotal, tipo: "ABONO" },
      ...(ivaTras
        ? [{ ...base, chartAccountId: ivaTras.id, monto: args.iva, tipo: "ABONO" as const }]
        : []),
      ...(propinas
        ? [{ ...base, chartAccountId: propinas.id, monto: args.propina, tipo: "ABONO" as const }]
        : []),
    ],
  });
}

/**
 * Costo de venta teórico de una orden cobrada (recipe cost) — relieves the
 * inventory the kitchen consumed.
 *   DR 5103 Costo de alimentos y bebidas
 *   CR 1107 Almacén de insumos
 *
 * Skipped by the caller when the order has no recipe-costed items (costo 0).
 */
export async function postCostoVentaRestaurante(
  tx: Tx,
  args: {
    companyId: string;
    ordenId: string;
    descripcion: string;
    costo: number;
    fecha: Date;
  }
): Promise<void> {
  await postBalancedEntry(tx, {
    companyId: args.companyId,
    fecha: args.fecha,
    descripcion: `Costo de venta — ${args.descripcion}`,
    monto: args.costo,
    fuente: "RESTAURANTE",
    referencia: args.ordenId,
    referenciaTipo: "REST_COSTO_VENTA",
    cargo: { cuentaSAT: "5103" },
    abono: { cuentaSAT: "1107" },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Purificadora module (venta de agua purificada / garrafones)
// ─────────────────────────────────────────────────────────────────────────────

export type PurifFormaPagoPosting =
  | "EFECTIVO"
  | "TRANSFERENCIA"
  | "TARJETA"
  | "CREDITO";

function purifCashAccountFor(
  formaPago: Exclude<PurifFormaPagoPosting, "CREDITO">
): string {
  switch (formaPago) {
    case "EFECTIVO":
      return "1100"; // Caja
    case "TRANSFERENCIA":
    case "TARJETA":
      return "1101"; // Bancos
  }
}

/**
 * Venta de agua / garrafones registrada — revenue side.
 *   DR 1100 Caja / 1101 Bancos / 1103 Cuentas por cobrar (CREDITO)  (= total)
 *   CR 4170 Ingresos por venta de agua purificada                   (= subtotal)
 *   CR 2102 IVA trasladado                                          (= iva, cuando > 0)
 *
 * El agua en garrafón es tasa 0% (Art. 2-A LIVA), así que normalmente esto es
 * un par de 2 patas; el IVA sólo aparece con presentaciones gravadas.
 */
export async function postVentaPurificadora(
  tx: Tx,
  args: {
    companyId: string;
    ventaId: string;
    descripcion: string; // e.g. "Venta V-0042 — Tienda La Esperanza"
    subtotal: number;
    iva: number;
    formaPago: PurifFormaPagoPosting;
    fecha: Date;
  }
): Promise<void> {
  const total = args.subtotal + args.iva;
  if (!(total > 0)) {
    throw new Error(`postVentaPurificadora: total must be > 0, got ${total}`);
  }

  const year = args.fecha.getUTCFullYear();
  const month = args.fecha.getUTCMonth() + 1;

  const cargoSAT =
    args.formaPago === "CREDITO"
      ? "1103" // Cuentas por cobrar — el cliente queda a deber
      : purifCashAccountFor(args.formaPago);

  const [cargo, ingresos, ivaTras] = await Promise.all([
    getOrCreateAccount(tx, args.companyId, cargoSAT),
    getOrCreateAccount(tx, args.companyId, "4170"),
    args.iva > 0 ? getOrCreateAccount(tx, args.companyId, "2102") : null,
  ]);

  const base = {
    companyId: args.companyId,
    fecha: args.fecha,
    year,
    month,
    descripcion: args.descripcion,
    referencia: args.ventaId,
    referenciaTipo: "PURIF_VENTA",
    fuente: "PURIFICADORA" as EntrySource,
  };

  await tx.accountingEntry.createMany({
    data: [
      { ...base, chartAccountId: cargo.id, monto: total, tipo: "CARGO" },
      { ...base, chartAccountId: ingresos.id, monto: args.subtotal, tipo: "ABONO" },
      ...(ivaTras
        ? [{ ...base, chartAccountId: ivaTras.id, monto: args.iva, tipo: "ABONO" as const }]
        : []),
    ],
  });
}

/**
 * Cobro de una venta a crédito (settles the receivable created at sale time).
 *   DR 1100 Caja / 1101 Bancos   (= monto)
 *   CR 1103 Cuentas por cobrar   (= monto)
 */
export async function postCobroVentaPurificadora(
  tx: Tx,
  args: {
    companyId: string;
    ventaId: string;
    descripcion: string;
    monto: number;
    formaPago: Exclude<PurifFormaPagoPosting, "CREDITO">;
    fecha: Date;
  }
): Promise<void> {
  await postBalancedEntry(tx, {
    companyId: args.companyId,
    fecha: args.fecha,
    descripcion: args.descripcion,
    monto: args.monto,
    fuente: "PURIFICADORA",
    referencia: args.ventaId,
    referenciaTipo: "PURIF_VENTA_COBRADA",
    cargo: { cuentaSAT: purifCashAccountFor(args.formaPago) },
    abono: { cuentaSAT: "1103" },
  });
}

/**
 * Cancelación de una venta — reverso espejo de lo que la venta llegó a postear.
 * Emite el reverso del asiento de venta y, si la venta a crédito ya se había
 * cobrado, también el reverso del cobro. El caller valida el estado (no se
 * cancelan ventas facturadas ni conciliadas) — aquí sólo se escriben los
 * asientos espejo para que el mayor quede neto en cero.
 */
export async function postCancelacionVentaPurificadora(
  tx: Tx,
  args: {
    companyId: string;
    ventaId: string;
    descripcion: string;
    subtotal: number;
    iva: number;
    formaPago: PurifFormaPagoPosting;
    cobro: { monto: number; formaPago: Exclude<PurifFormaPagoPosting, "CREDITO"> } | null;
    fecha: Date;
  }
): Promise<void> {
  const total = args.subtotal + args.iva;
  if (!(total > 0)) {
    throw new Error(`postCancelacionVentaPurificadora: total must be > 0, got ${total}`);
  }

  const year = args.fecha.getUTCFullYear();
  const month = args.fecha.getUTCMonth() + 1;

  const cargoSAT =
    args.formaPago === "CREDITO"
      ? "1103"
      : purifCashAccountFor(args.formaPago);

  const [cargo, ingresos, ivaTras] = await Promise.all([
    getOrCreateAccount(tx, args.companyId, cargoSAT),
    getOrCreateAccount(tx, args.companyId, "4170"),
    args.iva > 0 ? getOrCreateAccount(tx, args.companyId, "2102") : null,
  ]);

  const base = {
    companyId: args.companyId,
    fecha: args.fecha,
    year,
    month,
    descripcion: args.descripcion,
    referencia: args.ventaId,
    referenciaTipo: "PURIF_VENTA_CANCELADA",
    fuente: "PURIFICADORA" as EntrySource,
  };

  // Espejo de la venta: ABONO donde hubo CARGO y viceversa.
  await tx.accountingEntry.createMany({
    data: [
      { ...base, chartAccountId: cargo.id, monto: total, tipo: "ABONO" },
      { ...base, chartAccountId: ingresos.id, monto: args.subtotal, tipo: "CARGO" },
      ...(ivaTras
        ? [{ ...base, chartAccountId: ivaTras.id, monto: args.iva, tipo: "CARGO" as const }]
        : []),
    ],
  });

  // Espejo del cobro, si lo hubo: DR 1103 / CR Caja-Bancos.
  if (args.cobro) {
    await postBalancedEntry(tx, {
      companyId: args.companyId,
      fecha: args.fecha,
      descripcion: args.descripcion,
      monto: args.cobro.monto,
      fuente: "PURIFICADORA",
      referencia: args.ventaId,
      referenciaTipo: "PURIF_VENTA_CANCELADA",
      cargo: { cuentaSAT: "1103" },
      abono: { cuentaSAT: purifCashAccountFor(args.cobro.formaPago) },
    });
  }
}

/**
 * Gasto de operación de la purificadora (agua cruda, luz, filtros, renta, …).
 *   DR 5203 Gastos de operación purificadora  (= monto)
 *   CR 1100 Caja / 1101 Bancos                (= monto, pagado de contado)
 *   CR 2104 Acreedores diversos               (= monto, cuando formaPago = CREDITO)
 */
export async function postGastoPurificadora(
  tx: Tx,
  args: {
    companyId: string;
    gastoId: string;
    descripcion: string;
    monto: number;
    formaPago: PurifFormaPagoPosting;
    fecha: Date;
  }
): Promise<void> {
  const abonoSAT =
    args.formaPago === "CREDITO"
      ? "2104" // Acreedores diversos
      : purifCashAccountFor(args.formaPago);

  await postBalancedEntry(tx, {
    companyId: args.companyId,
    fecha: args.fecha,
    descripcion: args.descripcion,
    monto: args.monto,
    fuente: "PURIFICADORA",
    referencia: args.gastoId,
    referenciaTipo: "PURIF_GASTO",
    cargo: { cuentaSAT: "5203" },
    abono: { cuentaSAT: abonoSAT },
  });
}

/**
 * Compra a proveedor de la purificadora (insumos, agua cruda, refacciones…).
 *   DR 5203 Gastos de operación purificadora  (= total)
 *   CR 1100 Caja / 1101 Bancos                (= total, pagada de contado)
 *   CR 2104 Acreedores diversos               (= total, cuando formaPago = CREDITO)
 * El desglose costo-del-agua vs gasto de operación del estado de resultados
 * viaja por la categoría de la compra, no por la cuenta.
 */
export async function postCompraPurificadora(
  tx: Tx,
  args: {
    companyId: string;
    compraId: string;
    descripcion: string;
    monto: number;
    formaPago: PurifFormaPagoPosting;
    fecha: Date;
  }
): Promise<void> {
  const abonoSAT =
    args.formaPago === "CREDITO"
      ? "2104"
      : purifCashAccountFor(args.formaPago);

  await postBalancedEntry(tx, {
    companyId: args.companyId,
    fecha: args.fecha,
    descripcion: args.descripcion,
    monto: args.monto,
    fuente: "PURIFICADORA",
    referencia: args.compraId,
    referenciaTipo: "PURIF_COMPRA",
    cargo: { cuentaSAT: "5203" },
    abono: { cuentaSAT: abonoSAT },
  });
}

/**
 * Pago de una compra a crédito (settles the payable created at purchase).
 *   DR 2104 Acreedores diversos  (= monto)
 *   CR 1100 Caja / 1101 Bancos   (= monto)
 */
export async function postPagoCompraPurificadora(
  tx: Tx,
  args: {
    companyId: string;
    compraId: string;
    descripcion: string;
    monto: number;
    formaPago: Exclude<PurifFormaPagoPosting, "CREDITO">;
    fecha: Date;
  }
): Promise<void> {
  await postBalancedEntry(tx, {
    companyId: args.companyId,
    fecha: args.fecha,
    descripcion: args.descripcion,
    monto: args.monto,
    fuente: "PURIFICADORA",
    referencia: args.compraId,
    referenciaTipo: "PURIF_COMPRA_PAGADA",
    cargo: { cuentaSAT: "2104" },
    abono: { cuentaSAT: purifCashAccountFor(args.formaPago) },
  });
}

// ─── Automotriz (DMS) ────────────────────────────────────────────────────────
// La máquina de estados de `Vehiculo` (EN_TRANSITO → DISPONIBLE → APARTADO →
// VENDIDO) es la idempotencia: cada helper se llama exactamente una vez por
// transición, dentro de la transacción del caller.

/**
 * Unidad recibida en la agencia (EN_TRANSITO → DISPONIBLE).
 *   DR 1115 Inventario de vehículos
 *   CR 2104 Acreedores diversos
 * El pasivo se cancela después contra bancos vía conciliación / pago a
 * proveedor; si la compra trae CFDI, el vínculo vive en compraInvoiceId.
 */
export async function postVehiculoRecibido(
  tx: Tx,
  args: {
    companyId: string;
    vehiculoId: string;
    vin: string;
    costo: number; // sin IVA
    fecha: Date;
  }
): Promise<void> {
  await postBalancedEntry(tx, {
    companyId: args.companyId,
    fecha: args.fecha,
    descripcion: `Entrada de unidad VIN ${args.vin}`,
    monto: args.costo,
    fuente: "AUTOMOTRIZ",
    referencia: args.vehiculoId,
    referenciaTipo: "VEHICULO_COMPRA",
    cargo: { cuentaSAT: "1115" },
    abono: { cuentaSAT: "2104" },
  });
}

export type VehiculoCostoPosting =
  | "INTERES_PISO"
  | "ACONDICIONAMIENTO"
  | "TRASLADO"
  | "ACCESORIOS"
  | "OTRO";

/**
 * Costo unitario adicional.
 *   INTERES_PISO      → DR 5205 Intereses de plan piso / CR 2104 (gasto financiero)
 *   demás (capitaliza) → DR 1115 Inventario de vehículos / CR 2104
 * En ambos casos el costo suma a la utilidad-por-VIN vía VehiculoCosto.
 */
export async function postVehiculoCosto(
  tx: Tx,
  args: {
    companyId: string;
    costoId: string;
    vin: string;
    tipo: VehiculoCostoPosting;
    concepto: string;
    monto: number; // sin IVA
    fecha: Date;
  }
): Promise<void> {
  const esInteres = args.tipo === "INTERES_PISO";
  await postBalancedEntry(tx, {
    companyId: args.companyId,
    fecha: args.fecha,
    descripcion: `${esInteres ? "Interés plan piso" : args.concepto} — VIN ${args.vin}`,
    monto: args.monto,
    fuente: "AUTOMOTRIZ",
    referencia: args.costoId,
    referenciaTipo: esInteres ? "VEHICULO_INTERES_PISO" : "VEHICULO_COSTO",
    cargo: { cuentaSAT: esInteres ? "5205" : "1115" },
    abono: { cuentaSAT: "2104" },
  });
}

/**
 * Venta de la unidad (DISPONIBLE/APARTADO → VENDIDO). Doble bloque:
 *
 * Ingreso (hasta 4 legs, emitidos directo para que los totales sean exactos):
 *   DR 1103 Cuentas por cobrar   (= precio + IVA + ISAN)
 *   CR 4180 Ingresos por venta de vehículos (= precio sin IVA)
 *   CR 2102 IVA trasladado       (= iva)
 *   CR 2110 ISAN por pagar       (= isan, sólo unidades nuevas)
 *
 * Costo de ventas (saca del inventario el costo capitalizado):
 *   DR 5110 Costo de ventas de vehículos
 *   CR 1115 Inventario de vehículos
 */
export async function postVehiculoVendido(
  tx: Tx,
  args: {
    companyId: string;
    vehiculoId: string;
    vin: string;
    precio: number; // sin IVA
    iva: number;
    isan: number;
    costoInventario: number; // costo compra + costos capitalizados
    fecha: Date;
  }
): Promise<void> {
  const desc = `Venta de unidad VIN ${args.vin}`;
  const year = args.fecha.getUTCFullYear();
  const month = args.fecha.getUTCMonth() + 1;
  const total = args.precio + args.iva + args.isan;

  const [cxc, ingresos, ivaAcct, isanAcct] = await Promise.all([
    getOrCreateAccount(tx, args.companyId, "1103"),
    getOrCreateAccount(tx, args.companyId, "4180"),
    getOrCreateAccount(tx, args.companyId, "2102"),
    getOrCreateAccount(tx, args.companyId, "2110"),
  ]);

  const base = {
    companyId: args.companyId,
    fecha: args.fecha,
    year,
    month,
    descripcion: desc,
    referencia: args.vehiculoId,
    referenciaTipo: "VEHICULO_VENTA",
    fuente: "AUTOMOTRIZ" as EntrySource,
  };

  const data = [
    { ...base, chartAccountId: cxc.id, monto: total, tipo: "CARGO" as const },
    { ...base, chartAccountId: ingresos.id, monto: args.precio, tipo: "ABONO" as const },
  ];
  if (args.iva > 0) {
    data.push({ ...base, chartAccountId: ivaAcct.id, monto: args.iva, tipo: "ABONO" as const });
  }
  if (args.isan > 0) {
    data.push({ ...base, chartAccountId: isanAcct.id, monto: args.isan, tipo: "ABONO" as const });
  }
  await tx.accountingEntry.createMany({ data });

  if (args.costoInventario > 0) {
    await postBalancedEntry(tx, {
      companyId: args.companyId,
      fecha: args.fecha,
      descripcion: `Costo de venta — VIN ${args.vin}`,
      monto: args.costoInventario,
      fuente: "AUTOMOTRIZ",
      referencia: args.vehiculoId,
      referenciaTipo: "VEHICULO_COSTO_VENTA",
      cargo: { cuentaSAT: "5110" },
      abono: { cuentaSAT: "1115" },
    });
  }
}
