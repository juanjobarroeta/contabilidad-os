// ─────────────────────────────────────────────────────────────────────────────
// Posting engine — converts raw business events (CFDIs, bank txs) into
// double-entry AccountingEntry rows for a given (companyId, year, month).
//
// Design rules:
//   1. IDEMPOTENT: running postMonth() again for the same period first
//      wipes prior entries for that period, then re-inserts. This lets the
//      user re-post after fixing a category.
//   2. DOUBLE-ENTRY ALWAYS BALANCED: sum(cargos) === sum(abonos) per CFDI,
//      per bank tx, and per period overall. Unbalanced entries are a bug.
//   3. NO HUMAN-IN-THE-LOOP. The only inputs are existing data already
//      categorized. The "close month" action is deterministic.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { resolveAccount } from "./seed-catalog";
import { COE_CODES } from "./catalog";
import { classifyInvoice } from "./classify-egreso";
import type { Prisma, EntryType, EntrySource, AccountingPeriod } from "@prisma/client";

type EntryDraft = {
  chartAccountId: string;
  fecha: Date;
  descripcion: string;
  referencia: string | null;
  referenciaTipo: string | null;
  monto: number;
  tipo: EntryType;
  fuente: EntrySource;
};

export type PostMonthResult = {
  period: AccountingPeriod;
  entriesCreated: number;
  totalCargos: number;
  totalAbonos: number;
  warnings: string[];
};

export type PostMonthOptions = {
  companyId: string;
  year: number;
  month: number; // 1-12
};

function monthRange(year: number, month: number): { start: Date; end: Date } {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return { start, end };
}

/**
 * Runs the posting engine for a single month.
 *
 * Sources consumed:
 *   - Invoice (INGRESO, EGRESO) stamped in the period
 *   - BankTransaction in the period, grouped by status/notes:
 *       MATCHED (to invoice) → settles the invoice's client/supplier account
 *       IGNORED + TAX_PAYMENT       → debits impuestos por pagar
 *       IGNORED + PAYROLL_NO_CFDI   → debits sueldos y salarios
 *       IGNORED + NON_DEDUCTIBLE    → debits gastos no deducibles
 *       IGNORED + PENDING_MONTHLY_CFDI → debits "comisiones bancarias por conciliar"
 *                                      (will be reconciled when monthly CFDI matches)
 *       IGNORED + INTERNAL_TRANSFER → neutral (bank → bank, posted as both)
 *       UNMATCHED                   → warning, NOT posted (blocks clean close)
 */
export async function postMonth(opts: PostMonthOptions): Promise<PostMonthResult> {
  const { companyId, year, month } = opts;
  const { start, end } = monthRange(year, month);

  const warnings: string[] = [];
  const drafts: EntryDraft[] = [];

  // Load company to fail fast if missing
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true },
  });
  if (!company) throw new Error("Empresa no encontrada");

  // Pre-resolve the accounts we'll need most often
  const [
    accBancos,
    accClientes,
    accProveedores,
    accIvaTrasladado,
    accIvaAcreditable,
    accVentas,
    accComisionesBanc,
    accImpuestos,
    accSueldos,
    accNoDeducibles,
    accDiferencias,
    accIsrPagadoTerceros,
    accIsrRetenidoHonorarios,
    accPrestamosPorPagar,
    accPrestamosOtorgados,
    accCapitalSocial,
  ] = await Promise.all([
    resolveAccount(companyId, COE_CODES.BANCOS),
    resolveAccount(companyId, COE_CODES.CLIENTES_NACIONALES),
    resolveAccount(companyId, COE_CODES.PROVEEDORES),
    resolveAccount(companyId, COE_CODES.IVA_TRASLADADO),
    resolveAccount(companyId, COE_CODES.IVA_ACREDITABLE),
    resolveAccount(companyId, COE_CODES.VENTAS_GENERAL),
    resolveAccount(companyId, COE_CODES.COMISIONES_BANCARIAS),
    resolveAccount(companyId, COE_CODES.IMPUESTOS_DERECHOS),
    resolveAccount(companyId, COE_CODES.SUELDOS_SALARIOS),
    resolveAccount(companyId, COE_CODES.GASTOS_NO_DEDUCIBLES),
    resolveAccount(companyId, COE_CODES.DIFERENCIAS_REDONDEO),
    resolveAccount(companyId, COE_CODES.ISR_PAGADO_TERCEROS),
    resolveAccount(companyId, COE_CODES.ISR_RETENIDO_HONORARIOS),
    resolveAccount(companyId, COE_CODES.PRESTAMOS_RECIBIDOS),
    resolveAccount(companyId, COE_CODES.PRESTAMOS_OTORGADOS),
    resolveAccount(companyId, COE_CODES.CAPITAL_SOCIAL),
  ]);

  // ─── 1. CFDIs emitted (INGRESO) ────────────────────────────────────────
  // Debit: Clientes (full total)
  // Credit: Ventas (subtotal)
  // Credit: IVA trasladado (tax portion)
  const ingresos = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: "INGRESO",
      status: "STAMPED",
      fecha: { gte: start, lt: end },
    },
  });

  for (const inv of ingresos) {
    const ref = inv.uuid ?? inv.id;
    const base = {
      fecha: inv.fecha,
      descripcion: `Factura ingreso ${inv.serie ?? ""}${inv.folio ?? ""}`.trim(),
      referencia: ref,
      referenciaTipo: "CFDI" as const,
      fuente: "CFDI" as EntrySource,
    };

    // Compute the impuestos delta from the stored fields. Sign convention:
    //   delta = total - subtotal
    //   delta > 0  → IVA trasladado neto (cliente nos debe IVA)
    //   delta < 0  → ISR retenido a favor (cliente nos retuvo más de lo que cobramos en IVA)
    const delta = inv.total - inv.subtotal;

    drafts.push({
      ...base,
      chartAccountId: accClientes.id,
      monto: inv.total,
      tipo: "CARGO",
    });
    drafts.push({
      ...base,
      chartAccountId: accVentas.id,
      monto: inv.subtotal,
      tipo: "ABONO",
    });
    if (delta > 0.005) {
      drafts.push({
        ...base,
        chartAccountId: accIvaTrasladado.id,
        monto: delta,
        tipo: "ABONO",
      });
    } else if (delta < -0.005) {
      // Cliente nos retuvo: nace un activo (crédito al SAT)
      drafts.push({
        ...base,
        chartAccountId: accIsrPagadoTerceros.id,
        monto: -delta,
        tipo: "CARGO",
      });
    }
  }

  // ─── 1.5 CFDIs nómina (NOMINA) ─────────────────────────────────────────
  // CFDI nómina is OUR expense paid to an employee. The CFDI is "emitido"
  // by us but it's not a sale — it's a payroll record.
  //
  // Sign convention in our schema for CFDI nómina:
  //   subtotal       = total percepciones
  //   totalImpuestos = -ISR retenido (negative because it reduces what we
  //                    actually pay the employee)
  //   total          = neto pagado al empleado = subtotal + totalImpuestos
  //
  // Journal:
  //   DR Sueldos y salarios (subtotal = percepciones brutas)
  //   CR ISR retenido por sueldos (|totalImpuestos|, only if negative)
  //   CR Acreedores diversos / Bancos (total = neto)
  //
  // We post to "Acreedores diversos" (provision) instead of Bancos directly
  // because the bank movement settles separately. The bank tx that pays the
  // empleado is matched (or categorized as PAYROLL_NO_CFDI) and contributes
  // its own pair of entries that close out the provision.
  const nominaCfdis = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: "NOMINA",
      status: "STAMPED",
      fecha: { gte: start, lt: end },
    },
  });

  for (const inv of nominaCfdis) {
    const ref = inv.uuid ?? inv.id;
    const empName = inv.subtotal ? "" : ""; // placeholder if we ever load customer
    void empName;
    const base = {
      fecha: inv.fecha,
      descripcion: `Nómina CFDI ${inv.serie ?? ""}${inv.folio ?? ""}`.trim(),
      referencia: ref,
      referenciaTipo: "CFDI" as const,
      fuente: "NOMINA" as EntrySource,
    };

    // delta < 0 → impuestos retenidos (typical case for nómina)
    const delta = inv.total - inv.subtotal;

    drafts.push({
      ...base,
      chartAccountId: accSueldos.id,
      monto: inv.subtotal,
      tipo: "CARGO",
    });
    if (delta < -0.005) {
      drafts.push({
        ...base,
        chartAccountId: accIsrRetenidoHonorarios.id, // ISR/IVA retenido a proveedores (also used for nómina retenciones)
        monto: -delta,
        tipo: "ABONO",
      });
    } else if (delta > 0.005) {
      // Edge case: net > subtotal (shouldn't happen on a nomina but post safely)
      drafts.push({
        ...base,
        chartAccountId: accSueldos.id,
        monto: delta,
        tipo: "CARGO",
      });
    }
    // Acreedor por el neto al empleado (lo cierra el bank tx cuando se pague)
    drafts.push({
      ...base,
      chartAccountId: accProveedores.id,
      monto: inv.total,
      tipo: "ABONO",
    });
  }

  // ─── 2. CFDIs received (EGRESO) ────────────────────────────────────────
  // Debit: Gasto específico (classified by claveProdServ from the dominant
  //        line item — combustibles, rentas, honorarios, etc.)
  // Debit: IVA acreditable (tax portion)
  // Credit: Proveedores (full total)
  // Cache resolved accounts so we don't re-query within the loop
  const accountCache = new Map<string, string>();
  async function resolveCached(code: string): Promise<string> {
    const cached = accountCache.get(code);
    if (cached) return cached;
    const acc = await resolveAccount(companyId, code);
    accountCache.set(code, acc.id);
    return acc.id;
  }

  const egresos = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: "EGRESO",
      status: "STAMPED",
      fecha: { gte: start, lt: end },
    },
    include: {
      items: {
        select: { claveProdServ: true, importe: true },
      },
    },
  });

  for (const inv of egresos) {
    const ref = inv.uuid ?? inv.id;
    const base = {
      fecha: inv.fecha,
      descripcion: `Factura egreso ${inv.serie ?? ""}${inv.folio ?? ""}`.trim(),
      referencia: ref,
      referenciaTipo: "CFDI" as const,
      fuente: "CFDI" as EntrySource,
    };

    const delta = inv.total - inv.subtotal;

    // Classification: user override wins, otherwise auto-classify from SAT code.
    // The override is stored as the subcuenta SAT code (e.g. "601.15");
    // resolveCached will raise an error if it doesn't exist, which is what
    // we want — it means a user-supplied bad override, which shouldn't
    // silently fall back to Otros gastos.
    const classification = inv.overrideCuenta
      ? { cuenta: inv.overrideCuenta, label: "manual" }
      : classifyInvoice(
          inv.items.map((it) => ({ claveProdServ: it.claveProdServ, importe: it.importe }))
        );
    const gastoAccountId = await resolveCached(classification.cuenta);

    drafts.push({
      ...base,
      chartAccountId: gastoAccountId,
      monto: inv.subtotal,
      tipo: "CARGO",
    });
    if (delta > 0.005) {
      drafts.push({
        ...base,
        chartAccountId: accIvaAcreditable.id,
        monto: delta,
        tipo: "CARGO",
      });
    } else if (delta < -0.005) {
      // Le retuvimos al proveedor (típico en honorarios/arrendamiento): pasivo a SAT
      drafts.push({
        ...base,
        chartAccountId: accIsrRetenidoHonorarios.id,
        monto: -delta,
        tipo: "ABONO",
      });
    }
    drafts.push({
      ...base,
      chartAccountId: accProveedores.id,
      monto: inv.total,
      tipo: "ABONO",
    });
  }

  // ─── 3. Bank transactions ──────────────────────────────────────────────
  const bankTxs = await prisma.bankTransaction.findMany({
    where: {
      companyId,
      fecha: { gte: start, lt: end },
    },
  });

  // Strict mode: refuse to close the month if any bank tx is still UNMATCHED.
  // Every movement must be either matched to a CFDI or categorized (taxes,
  // payroll, no deducible, etc.) before the books can close. This guarantees
  // the Bancos account in the balanza reflects the true balance.
  const unmatched = bankTxs.filter((t) => t.status === "UNMATCHED");
  if (unmatched.length > 0) {
    const sample = unmatched
      .slice(0, 3)
      .map(
        (t) =>
          `· ${t.fecha.toISOString().slice(0, 10)} ${t.descripcion.slice(0, 40)} $${Math.abs(t.monto).toFixed(2)}`
      )
      .join("\n");
    const more = unmatched.length > 3 ? `\n…y ${unmatched.length - 3} más` : "";
    throw new Error(
      `No se puede cerrar el mes: ${unmatched.length} movimiento(s) sin conciliar.\nResuélvelos en Bancos antes de cerrar.\n\n${sample}${more}`
    );
  }

  for (const tx of bankTxs) {
    const absAmount = Math.abs(tx.monto);
    const isCredit = tx.monto > 0; // money in = bank debit
    const ref = tx.id;
    const base = {
      fecha: tx.fecha,
      descripcion: tx.descripcion.substring(0, 200),
      referencia: ref,
      referenciaTipo: "BANK_TX" as const,
      fuente: "BANCO" as EntrySource,
    };

    if (tx.status === "UNMATCHED") {
      warnings.push(
        `Movimiento sin conciliar: ${tx.fecha.toISOString().slice(0, 10)} ${tx.descripcion.slice(0, 40)} $${absAmount.toFixed(2)}`
      );
      continue; // not posted
    }

    if (tx.status === "MATCHED" && tx.invoiceId) {
      // Settles the clientes/proveedores account that the CFDI originally hit
      if (isCredit) {
        // Cobro de factura: debit bank, credit clientes
        drafts.push({ ...base, chartAccountId: accBancos.id, monto: absAmount, tipo: "CARGO" });
        drafts.push({ ...base, chartAccountId: accClientes.id, monto: absAmount, tipo: "ABONO" });
      } else {
        // Pago a proveedor: debit proveedores, credit bank
        drafts.push({ ...base, chartAccountId: accProveedores.id, monto: absAmount, tipo: "CARGO" });
        drafts.push({ ...base, chartAccountId: accBancos.id, monto: absAmount, tipo: "ABONO" });
      }
      continue;
    }

    if (tx.status === "IGNORED") {
      const tag = tx.notes ?? "";

      if (tag === "PENDING_MONTHLY_CFDI") {
        // Bank fee, monthly CFDI hasn't arrived yet. Post the expense provisionally
        // to comisiones bancarias (the CFDI match later won't create new entries
        // because the tx is already in MATCHED status at that point — we'd need
        // a re-post, which the user can trigger manually).
        drafts.push({ ...base, chartAccountId: accComisionesBanc.id, monto: absAmount, tipo: "CARGO" });
        drafts.push({ ...base, chartAccountId: accBancos.id, monto: absAmount, tipo: "ABONO" });
        continue;
      }

      if (tag === "TAX_PAYMENT") {
        drafts.push({ ...base, chartAccountId: accImpuestos.id, monto: absAmount, tipo: "CARGO" });
        drafts.push({ ...base, chartAccountId: accBancos.id, monto: absAmount, tipo: "ABONO" });
        continue;
      }

      if (tag === "PAYROLL_NO_CFDI") {
        // Same treatment as expense — you should emit CFDI nómina eventually,
        // but for now this keeps the books balanced.
        drafts.push({ ...base, chartAccountId: accSueldos.id, monto: absAmount, tipo: "CARGO" });
        drafts.push({ ...base, chartAccountId: accBancos.id, monto: absAmount, tipo: "ABONO" });
        continue;
      }

      if (tag === "NON_DEDUCTIBLE") {
        drafts.push({ ...base, chartAccountId: accNoDeducibles.id, monto: absAmount, tipo: "CARGO" });
        drafts.push({ ...base, chartAccountId: accBancos.id, monto: absAmount, tipo: "ABONO" });
        continue;
      }

      if (tag === "INTERNAL_TRANSFER") {
        // Neutral: we debit and credit bank. For v1 we only use one bank account
        // so this is a wash. When multi-account arrives we'll resolve the target
        // bank account from tx.notes JSON.
        drafts.push({ ...base, chartAccountId: accBancos.id, monto: absAmount, tipo: "CARGO" });
        drafts.push({ ...base, chartAccountId: accBancos.id, monto: absAmount, tipo: "ABONO" });
        continue;
      }

      if (tag === "LOAN_RECEIVED") {
        // Préstamo que NOS DIERON. Direction matters:
        //   inflow → DR Bancos / CR Préstamos por pagar  (deuda nace)
        //   outflow → DR Préstamos por pagar / CR Bancos  (estamos pagando deuda)
        if (isCredit) {
          drafts.push({ ...base, chartAccountId: accBancos.id,           monto: absAmount, tipo: "CARGO" });
          drafts.push({ ...base, chartAccountId: accPrestamosPorPagar.id, monto: absAmount, tipo: "ABONO" });
        } else {
          drafts.push({ ...base, chartAccountId: accPrestamosPorPagar.id, monto: absAmount, tipo: "CARGO" });
          drafts.push({ ...base, chartAccountId: accBancos.id,           monto: absAmount, tipo: "ABONO" });
        }
        continue;
      }

      if (tag === "LOAN_GIVEN") {
        // Préstamo que NOSOTROS DIMOS a un tercero:
        //   outflow → DR Préstamos otorgados / CR Bancos  (nace el activo)
        //   inflow → DR Bancos / CR Préstamos otorgados  (nos están pagando)
        if (isCredit) {
          drafts.push({ ...base, chartAccountId: accBancos.id,            monto: absAmount, tipo: "CARGO" });
          drafts.push({ ...base, chartAccountId: accPrestamosOtorgados.id, monto: absAmount, tipo: "ABONO" });
        } else {
          drafts.push({ ...base, chartAccountId: accPrestamosOtorgados.id, monto: absAmount, tipo: "CARGO" });
          drafts.push({ ...base, chartAccountId: accBancos.id,            monto: absAmount, tipo: "ABONO" });
        }
        continue;
      }

      if (tag === "CAPITAL_CONTRIBUTION") {
        // Aportación de socios:
        //   inflow → DR Bancos / CR Capital social
        //   outflow → DR Capital social / CR Bancos (retiro de capital, raro)
        if (isCredit) {
          drafts.push({ ...base, chartAccountId: accBancos.id,        monto: absAmount, tipo: "CARGO" });
          drafts.push({ ...base, chartAccountId: accCapitalSocial.id, monto: absAmount, tipo: "ABONO" });
        } else {
          drafts.push({ ...base, chartAccountId: accCapitalSocial.id, monto: absAmount, tipo: "CARGO" });
          drafts.push({ ...base, chartAccountId: accBancos.id,        monto: absAmount, tipo: "ABONO" });
        }
        continue;
      }

      // Plain ignored (no tag) — skip, not posted
      warnings.push(
        `Movimiento ignorado sin categoría: ${tx.fecha.toISOString().slice(0, 10)} ${tx.descripcion.slice(0, 40)}`
      );
      continue;
    }
  }

  // ─── Balance check before persistence ──────────────────────────────────
  const totalCargos = drafts.filter(d => d.tipo === "CARGO").reduce((s, d) => s + d.monto, 0);
  const totalAbonos = drafts.filter(d => d.tipo === "ABONO").reduce((s, d) => s + d.monto, 0);
  const diff = Math.abs(totalCargos - totalAbonos);
  if (diff > 0.01) {
    throw new Error(
      `Balance check failed: cargos=${totalCargos.toFixed(2)} abonos=${totalAbonos.toFixed(2)} diff=${diff.toFixed(2)}`
    );
  }

  // ─── Persist atomically ────────────────────────────────────────────────
  // Wipe any prior entries for this period so we can re-post after fixes.
  const period = await prisma.$transaction(async (tx) => {
    // Find or create the period row
    const periodRow = await tx.accountingPeriod.upsert({
      where: { companyId_year_month: { companyId, year, month } },
      update: {},
      create: { companyId, year, month, status: "DRAFT" },
    });

    // Wipe prior entries for this period
    await tx.accountingEntry.deleteMany({
      where: { companyId, periodId: periodRow.id },
    });

    // Insert new entries
    if (drafts.length > 0) {
      const data: Prisma.AccountingEntryCreateManyInput[] = drafts.map(d => ({
        companyId,
        chartAccountId: d.chartAccountId,
        year,
        month,
        periodId: periodRow.id,
        fecha: d.fecha,
        descripcion: d.descripcion,
        referencia: d.referencia,
        referenciaTipo: d.referenciaTipo,
        monto: d.monto,
        tipo: d.tipo,
        fuente: d.fuente,
      }));
      await tx.accountingEntry.createMany({ data });
    }

    // Update period status + summary
    return tx.accountingPeriod.update({
      where: { id: periodRow.id },
      data: {
        status: "POSTED",
        postedAt: new Date(),
        entriesCount: drafts.length,
        totalCargos,
        totalAbonos,
      },
    });
  });

  return {
    period,
    entriesCreated: drafts.length,
    totalCargos,
    totalAbonos,
    warnings,
  };
}

/**
 * Deletes all entries for a period and marks it DRAFT. Used for "reopen".
 */
export async function unpostMonth(companyId: string, year: number, month: number) {
  await prisma.$transaction(async (tx) => {
    const period = await tx.accountingPeriod.findUnique({
      where: { companyId_year_month: { companyId, year, month } },
    });
    if (!period) return;
    await tx.accountingEntry.deleteMany({ where: { periodId: period.id } });
    await tx.accountingPeriod.update({
      where: { id: period.id },
      data: { status: "DRAFT", entriesCount: 0, totalCargos: 0, totalAbonos: 0, postedAt: null },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reports — pull from AccountingEntry, never recompute from source data
// ─────────────────────────────────────────────────────────────────────────────

export type BalanzaRow = {
  cuentaSAT: string;
  subcuenta: string | null;
  nombre: string;
  tipo: string;
  nivel: number;
  cargos: number;
  abonos: number;
  saldo: number; // signed per account type
};

/**
 * Balanza de comprobación for a given year+month (or period range).
 * Returns one row per ChartAccount with totals.
 */
export async function balanza(companyId: string, year: number, month: number): Promise<BalanzaRow[]> {
  const accounts = await prisma.chartAccount.findMany({
    where: { companyId, isActive: true },
    include: {
      entries: {
        where: { year, month },
        select: { tipo: true, monto: true },
      },
    },
    orderBy: [{ cuentaSAT: "asc" }, { subcuenta: "asc" }],
  });

  return accounts.map(acc => {
    const cargos = acc.entries.filter(e => e.tipo === "CARGO").reduce((s, e) => s + e.monto, 0);
    const abonos = acc.entries.filter(e => e.tipo === "ABONO").reduce((s, e) => s + e.monto, 0);
    // Sign convention: ACTIVO/GASTO/COSTO natural debit → saldo = cargos - abonos
    // PASIVO/CAPITAL/INGRESO natural credit → saldo = abonos - cargos
    const naturalDebit = ["ACTIVO", "GASTO", "COSTO"].includes(acc.tipo);
    const saldo = naturalDebit ? cargos - abonos : abonos - cargos;

    return {
      cuentaSAT: acc.cuentaSAT,
      subcuenta: acc.subcuenta,
      nombre: acc.nombre,
      tipo: acc.tipo,
      nivel: acc.nivel,
      cargos,
      abonos,
      saldo,
    };
  });
}

export type EstadoResultadosRow = {
  seccion: "INGRESOS" | "COSTOS" | "GASTOS";
  cuentaSAT: string;
  subcuenta: string | null;
  nombre: string;
  monto: number;
};

export type EstadoResultados = {
  ingresos: EstadoResultadosRow[];
  costos: EstadoResultadosRow[];
  gastos: EstadoResultadosRow[];
  totalIngresos: number;
  totalCostos: number;
  totalGastos: number;
  utilidadBruta: number;
  utilidadAntesImpuestos: number;
};

/**
 * Estado de resultados (P&L) for a given month. Computed from balanza.
 */
export async function estadoResultados(
  companyId: string,
  year: number,
  month: number
): Promise<EstadoResultados> {
  const rows = await balanza(companyId, year, month);

  const ingresos: EstadoResultadosRow[] = [];
  const costos: EstadoResultadosRow[] = [];
  const gastos: EstadoResultadosRow[] = [];

  for (const r of rows) {
    if (r.nivel < 3) continue; // skip headers
    if (Math.abs(r.saldo) < 0.01) continue; // skip empty
    const row: EstadoResultadosRow = {
      seccion: r.tipo as "INGRESOS" | "COSTOS" | "GASTOS",
      cuentaSAT: r.cuentaSAT,
      subcuenta: r.subcuenta,
      nombre: r.nombre,
      monto: r.saldo,
    };
    if (r.tipo === "INGRESO") ingresos.push({ ...row, seccion: "INGRESOS" });
    else if (r.tipo === "COSTO") costos.push({ ...row, seccion: "COSTOS" });
    else if (r.tipo === "GASTO") gastos.push({ ...row, seccion: "GASTOS" });
  }

  const totalIngresos = ingresos.reduce((s, r) => s + r.monto, 0);
  const totalCostos = costos.reduce((s, r) => s + r.monto, 0);
  const totalGastos = gastos.reduce((s, r) => s + r.monto, 0);
  const utilidadBruta = totalIngresos - totalCostos;
  const utilidadAntesImpuestos = utilidadBruta - totalGastos;

  return {
    ingresos,
    costos,
    gastos,
    totalIngresos,
    totalCostos,
    totalGastos,
    utilidadBruta,
    utilidadAntesImpuestos,
  };
}
