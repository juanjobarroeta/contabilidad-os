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
import { naturalezaPorTipo, saldosCoe } from "./coe-saldos";
import { classifyInvoice } from "./classify-egreso";
import { esComprobanteDeEgreso, espejo, signoDeComprobante } from "./nota-credito";
import { cargarContextoTaller, piernasIngresoTaller } from "./taller";
import {
  cargarIndiceFamilia,
  cuentaDeFamilia,
  unidadesAmparadas,
  MOTOR_VENTAS_UNIDAD,
  MOTOR_COSTO_UNIDAD,
  MOTOR_INVENTARIO_UNIDAD,
} from "./resolver-familia";
import {
  cargarCuentasCxc,
  conjuntosModulo,
  moduloDeInvoice,
  kindPorInvoice,
  kindComun,
} from "./cxc-cxp-modulo";
import { calcularDepreciacionMes, CUENTA_ACTIVO_FIJO } from "./depreciacion-contable";
import { tipoActivoDesdeSubtipo } from "../fiscal/depreciacion";
import { assertPeriodoAbierto } from "./candado";
import { PeriodoCerradoError } from "./ejercicio";
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

// ─────────────────────────────────────────────────────────────────────────────
// Fuentes que postMonth() REGENERA en cada re-posteo. Sólo estas se borran al
// re-postear un mes; el resto (APERTURA, MANUAL, CONSTRUCCION, FLOTA, PADEL,
// CIERRE) se PRESERVA porque lo capturan a mano el contador u otros módulos
// satélite y postMonth nunca lo vuelve a generar.
export const REGENERATED_SOURCES: readonly EntrySource[] = ["CFDI", "NOMINA", "BANCO", "DEPRECIACION"];

export type EntrySummary = { entriesCount: number; totalCargos: number; totalAbonos: number };

// Resume cargos/abonos/conteo sobre TODOS los asientos de un periodo (incluidos
// los preservados), para que la balanza y los totales del periodo cuadren tras
// un re-posteo no destructivo. Pura: sin acceso a DB, fácil de testear.
export function summarizeEntries(
  entries: ReadonlyArray<{ tipo: EntryType; monto: number }>
): EntrySummary {
  let totalCargos = 0;
  let totalAbonos = 0;
  for (const e of entries) {
    if (e.tipo === "CARGO") totalCargos += e.monto;
    else if (e.tipo === "ABONO") totalAbonos += e.monto;
  }
  return { entriesCount: entries.length, totalCargos, totalAbonos };
}

// Modela el re-posteo no destructivo: dado el conjunto de asientos existentes en
// el periodo y los recién generados (sólo REGENERATED_SOURCES), devuelve los que
// quedan tras un re-posteo: se borran los existentes con fuente regenerable y se
// sustituyen por los nuevos; todo lo demás se conserva. Pura, para tests.
export function simulateRepost<T extends { fuente: EntrySource }>(
  existing: ReadonlyArray<T>,
  regenerated: ReadonlyArray<T>
): T[] {
  const regen = new Set<EntrySource>(REGENERATED_SOURCES);
  const preserved = existing.filter((e) => !regen.has(e.fuente));
  return [...preserved, ...regenerated];
}

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
 *       MATCHED (to TaxDeclaration, taxDeclarationId) → NOT posted (v1): no es
 *           liquidación de Clientes/Proveedores; el enteramiento pertenece al
 *           módulo de impuestos (ver comentario y TODO en el loop)
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

  // Candado de ejercicio: un mes de un ejercicio cerrado no se re-postea. Se
  // comprueba aquí para fallar barato (antes de leer CFDIs, bancos y nómina) y
  // otra vez dentro de la transacción, que es donde la decisión es autoritativa.
  await assertPeriodoAbierto(prisma, companyId, year, month);

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
    accImssPatronalGasto,
    accImssPorPagar,
    accAcreedoresDiv,
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
    resolveAccount(companyId, COE_CODES.CUOTAS_IMSS_PATRONAL),
    resolveAccount(companyId, COE_CODES.IMSS_POR_PAGAR),
    resolveAccount(companyId, COE_CODES.ACREEDORES_DIVERSOS),
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

  // FASE 2 (plan propio por FAMILIA): si el CFDI ampara una unidad NUEVA de
  // venta, la venta cae en la subcuenta de su familia (4101-00XX) y el costo
  // sale del inventario de la misma familia (DR 5101-00XX / CR 1301-00XX por
  // el costo de compra) — las MISMAS cuentas que declara la balanza. Sin
  // familia, sin CT o con ambigüedad → exactamente el flujo de siempre.
  // Ver docs/PLAN-motor-plan-propio.md y resolver-familia.ts.
  const idxFamilia = await cargarIndiceFamilia(companyId);
  const ventasUnidad = await unidadesAmparadas(companyId, ingresos.map((i) => i.id), "venta");
  // FASE 2b: la CxC también resuelve por módulo (unidades → 1206, refacciones
  // → 1217, servicio → 1214). Ver cxc-cxp-modulo.ts.
  const cuentasCxc = await cargarCuentasCxc(companyId);
  const modulosIngreso = await conjuntosModulo(companyId, ingresos.map((i) => i.id));
  // FASE 2d: lo que no es unidad puede ser taller — mano de obra a 4301 y
  // refacciones a 4401, partidas con el corte del DMS. Ver taller.ts.
  const taller = await cargarContextoTaller(companyId, ingresos.map((i) => i.id));

  for (const inv of ingresos) {
    const ref = inv.uuid ?? inv.id;
    // Nota de crédito, devolución o aplicación de anticipo: mismas cuentas,
    // asiento invertido. Ver nota-credito.ts.
    const esEgreso = esComprobanteDeEgreso(inv);
    const base = {
      fecha: inv.fecha,
      descripcion: `${esEgreso ? "Nota de egreso" : "Factura ingreso"} ${inv.serie ?? ""}${inv.folio ?? ""}`.trim(),
      referencia: ref,
      referenciaTipo: "CFDI" as const,
      fuente: "CFDI" as EntrySource,
    };

    // Compute the impuestos delta from the stored fields. Sign convention:
    //   delta = total - subtotal
    //   delta > 0  → IVA trasladado neto (cliente nos debe IVA)
    //   delta < 0  → ISR retenido a favor (cliente nos retuvo más de lo que cobramos en IVA)
    const delta = inv.total - inv.subtotal;

    const unidad = ventasUnidad.get(inv.id);
    const ctaVentaFam = unidad ? cuentaDeFamilia(idxFamilia, MOTOR_VENTAS_UNIDAD, unidad.sufijo) : null;
    const moduloCxc = moduloDeInvoice(inv.id, modulosIngreso);
    const ctaCxc = moduloCxc ? cuentasCxc[moduloCxc] : null;

    drafts.push({
      ...base,
      chartAccountId: (ctaCxc ?? accClientes).id,
      monto: inv.total,
      tipo: espejo("CARGO", esEgreso),
    });
    // La unidad manda; después el taller; al final la cuenta de ingresos de
    // siempre. Las piernas del taller suman el subtotal exacto.
    const piernasVenta = ctaVentaFam
      ? [{ id: ctaVentaFam.id, monto: inv.subtotal }]
      : (piernasIngresoTaller(inv.id, inv.subtotal, taller)?.map((p) => ({
          id: p.cuenta.id,
          monto: p.monto,
        })) ?? [{ id: accVentas.id, monto: inv.subtotal }]);
    for (const pierna of piernasVenta) {
      drafts.push({
        ...base,
        chartAccountId: pierna.id,
        monto: pierna.monto,
        tipo: espejo("ABONO", esEgreso),
      });
    }

    // Costo de venta de la unidad: sólo cuando las TRES cuentas de la familia
    // existen (venta, costo, inventario). Aliviar un inventario que no se
    // cargó — o al revés — desbalancearía la serie 1301 contra la CE.
    // El costo lo reconoce la factura, no la nota: revertirlo aquí exigiría
    // saber si la unidad regresó al piso, y eso lo dice el inventario, no el
    // CFDI.
    if (!esEgreso && unidad && ctaVentaFam && unidad.costo > 0.005) {
      const ctaCostoFam = cuentaDeFamilia(idxFamilia, MOTOR_COSTO_UNIDAD, unidad.sufijo);
      const ctaInvFam = cuentaDeFamilia(idxFamilia, MOTOR_INVENTARIO_UNIDAD, unidad.sufijo);
      if (ctaCostoFam && ctaInvFam) {
        const baseCosto = { ...base, descripcion: `Costo de venta VIN ${unidad.vin}` };
        drafts.push({ ...baseCosto, chartAccountId: ctaCostoFam.id, monto: unidad.costo, tipo: "CARGO" });
        drafts.push({ ...baseCosto, chartAccountId: ctaInvFam.id, monto: unidad.costo, tipo: "ABONO" });
      }
    }
    if (delta > 0.005) {
      drafts.push({
        ...base,
        chartAccountId: accIvaTrasladado.id,
        monto: delta,
        tipo: espejo("ABONO", esEgreso),
      });
    } else if (delta < -0.005) {
      // Cliente nos retuvo: nace un activo (crédito al SAT)
      drafts.push({
        ...base,
        chartAccountId: accIsrPagadoTerceros.id,
        monto: -delta,
        tipo: espejo("CARGO", esEgreso),
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
    // Acreedor por el neto al empleado (lo cierra el bank tx cuando se pague).
    // ACREEDORES (205.02 → 2207-0001 vía Fase 1), no proveedores: la nómina no
    // es un proveedor, y el override de CXP PLANTA volvió visible el error.
    drafts.push({
      ...base,
      chartAccountId: accAcreedoresDiv.id,
      monto: inv.total,
      tipo: "ABONO",
    });
  }

  // ─── 1.6 IMSS Patronal — employer's IMSS cost from PayrollItems ────────
  // The nómina CFDIs above only record what the employee gets/has deducted.
  // The EMPLOYER's IMSS contribution is an additional cost not in the CFDI.
  // We post it as: DR Cuotas IMSS Patronal (gasto) / CR IMSS por Pagar (pasivo)
  {
    const payrollItems = await prisma.payrollItem.findMany({
      where: {
        payrollRun: {
          companyId,
          status: { in: ["CALCULATED", "STAMPED", "PAID"] },
          fechaPago: { gte: start, lt: end },
        },
        imssPatronal: { gt: 0 },
      },
      select: { imssPatronal: true, payrollRun: { select: { periodo: true } } },
    });

    const totalImssPatronal = payrollItems.reduce((s, i) => s + i.imssPatronal, 0);
    if (totalImssPatronal > 0.01) {
      const base = {
        fecha: new Date(year, month - 1, Math.min(15, end.getDate())),
        descripcion: `Cuotas IMSS patronal ${year}-${String(month).padStart(2, "0")}`,
        referencia: `IMSS-PATRONAL-${year}-${String(month).padStart(2, "0")}`,
        referenciaTipo: "NOMINA" as const,
        fuente: "NOMINA" as EntrySource,
      };
      drafts.push({
        ...base,
        chartAccountId: accImssPatronalGasto.id,
        monto: Math.round(totalImssPatronal * 100) / 100,
        tipo: "CARGO",
      });
      drafts.push({
        ...base,
        chartAccountId: accImssPorPagar.id,
        monto: Math.round(totalImssPatronal * 100) / 100,
        tipo: "ABONO",
      });
    }
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

  // CFDIs clasificados INVERSION: el cargo va al ACTIVO FIJO (15x), no a
  // gasto — de otro modo la compra se duplicaría contra la depreciación.
  // La cuenta 15x sale del tipo del ActivoFijo ligado al CFDI (auto-creado
  // por la clasificación fiscal); sin activo ligado, 160.01 Otros activos.
  const activosPorInvoice = new Map<string, string>();
  {
    const inversionIds = egresos.filter((i) => i.naturaleza === "INVERSION").map((i) => i.id);
    if (inversionIds.length > 0) {
      const activos = await prisma.activoFijo.findMany({
        where: { invoiceId: { in: inversionIds } },
        select: { invoiceId: true, tipo: true },
      });
      for (const a of activos) {
        if (a.invoiceId) {
          activosPorInvoice.set(a.invoiceId, CUENTA_ACTIVO_FIJO[tipoActivoDesdeSubtipo(a.tipo)]);
        }
      }
    }
  }

  // FASE 2: la compra de una unidad NUEVA carga al INVENTARIO de su familia
  // (1301-00XX), no a gasto por clasificador — así la serie 1301 derivada se
  // vuelve comparable renglón a renglón contra la balanza presentada, y el
  // costo se reconoce al VENDER (ver el costo de venta en el flujo de
  // ingresos), no al comprar.
  const comprasUnidad = await unidadesAmparadas(companyId, egresos.map((i) => i.id), "compra");

  for (const inv of egresos) {
    const ref = inv.uuid ?? inv.id;
    // Nota de crédito RECIBIDA: el proveedor deshace su factura. Espejo.
    const esEgreso = esComprobanteDeEgreso(inv);
    const base = {
      fecha: inv.fecha,
      descripcion: `${esEgreso ? "Nota de crédito recibida" : "Factura egreso"} ${inv.serie ?? ""}${inv.folio ?? ""}`.trim(),
      referencia: ref,
      referenciaTipo: "CFDI" as const,
      fuente: "CFDI" as EntrySource,
    };

    const delta = inv.total - inv.subtotal;

    // Classification: user override wins, otherwise auto-classify from SAT code.
    // The override is stored as the subcuenta SAT code (e.g. "601.48");
    // resolveCached will raise an error if it doesn't exist, which is what
    // we want — it means a user-supplied bad override, which shouldn't
    // silently fall back to Otros gastos. Los CFDIs INVERSION van al activo
    // fijo (15x) salvo override manual explícito. La FAMILIA (inventario de la
    // unidad amparada) va después del override y de INVERSION: la decisión
    // humana y la de activo fijo mandan sobre la derivación automática.
    const unidadComprada =
      !inv.overrideCuenta && inv.naturaleza !== "INVERSION" ? comprasUnidad.get(inv.id) : undefined;
    const ctaInvFam = unidadComprada
      ? cuentaDeFamilia(idxFamilia, MOTOR_INVENTARIO_UNIDAD, unidadComprada.sufijo)
      : null;
    const classification = inv.overrideCuenta
      ? { cuenta: inv.overrideCuenta, label: "manual" }
      : inv.naturaleza === "INVERSION"
        ? { cuenta: activosPorInvoice.get(inv.id) ?? "160.01", label: "activo fijo" }
        : classifyInvoice(
            inv.items.map((it) => ({ claveProdServ: it.claveProdServ, importe: it.importe }))
          );
    const gastoAccountId = ctaInvFam ? ctaInvFam.id : await resolveCached(classification.cuenta);

    drafts.push({
      ...base,
      chartAccountId: gastoAccountId,
      monto: inv.subtotal,
      tipo: espejo("CARGO", esEgreso),
    });
    if (delta > 0.005) {
      drafts.push({
        ...base,
        chartAccountId: accIvaAcreditable.id,
        monto: delta,
        tipo: espejo("CARGO", esEgreso),
      });
    } else if (delta < -0.005) {
      // Le retuvimos al proveedor (típico en honorarios/arrendamiento): pasivo a SAT
      drafts.push({
        ...base,
        chartAccountId: accIsrRetenidoHonorarios.id,
        monto: -delta,
        tipo: espejo("ABONO", esEgreso),
      });
    }
    drafts.push({
      ...base,
      chartAccountId: accProveedores.id,
      monto: inv.total,
      tipo: espejo("ABONO", esEgreso),
    });
  }

  // ─── 2b. Depreciación contable del mes (fuente DEPRECIACION) ───────────
  // Nominal, sin tope de automóvil (ambos son fiscales — ver
  // depreciacion-contable.ts). Regenerable: cada re-posteo la reconstruye del
  // registro de activos, igual que CFDI/NOMINA/BANCO. Bajas del mes: se
  // cancela MOI y acumulada; el valor en libros va a resultados (703.xx).
  {
    const activosFijos = await prisma.activoFijo.findMany({
      where: { companyId },
      select: {
        id: true, descripcion: true, tipo: true, moi: true,
        fechaAdquisicion: true, fechaInicioUso: true, tasaAnual: true, fechaBaja: true,
      },
    });
    if (activosFijos.length > 0) {
      const { mensuales, bajas } = calcularDepreciacionMes(
        activosFijos.map((a) => ({
          id: a.id,
          descripcion: a.descripcion,
          tipo: a.tipo,
          moi: a.moi,
          fechaInicioUso: a.fechaInicioUso ?? a.fechaAdquisicion,
          tasaAnual: a.tasaAnual,
          fechaBaja: a.fechaBaja,
        })),
        year,
        month
      );
      const finDeMes = new Date(Date.UTC(year, month, 0, 12));
      for (const m of mensuales) {
        const base = {
          fecha: finDeMes,
          descripcion: `Depreciación contable · ${m.descripcion}`,
          referencia: m.activoId,
          referenciaTipo: "ACTIVO",
          fuente: "DEPRECIACION" as EntrySource,
        };
        drafts.push({ ...base, chartAccountId: await resolveCached(m.cuentaGasto), monto: m.monto, tipo: "CARGO" });
        drafts.push({ ...base, chartAccountId: await resolveCached(m.cuentaAcumulada), monto: m.monto, tipo: "ABONO" });
      }
      for (const b of bajas) {
        const base = {
          fecha: finDeMes,
          descripcion: `Baja de activo fijo · ${b.descripcion}`,
          referencia: b.activoId,
          referenciaTipo: "ACTIVO",
          fuente: "DEPRECIACION" as EntrySource,
        };
        if (b.acumuladaALaBaja > 0.005) {
          drafts.push({ ...base, chartAccountId: await resolveCached(b.cuentaAcumulada), monto: b.acumuladaALaBaja, tipo: "CARGO" });
        }
        if (b.valorEnLibros > 0.005) {
          drafts.push({ ...base, chartAccountId: await resolveCached(b.cuentaPerdida), monto: b.valorEnLibros, tipo: "CARGO" });
        }
        drafts.push({ ...base, chartAccountId: await resolveCached(b.cuentaActivo), monto: b.moi, tipo: "ABONO" });
      }
      if (mensuales.length > 0 || bajas.length > 0) {
        warnings.push(
          `Depreciación contable: ${mensuales.length} activo(s) depreciado(s)` +
          (bajas.length > 0 ? `, ${bajas.length} baja(s) registrada(s)` : "") +
          ` — la actualización INPC y el tope de automóvil son sólo fiscales (declaración).`
        );
      }
    }
  }

  // ─── 3. Bank transactions ──────────────────────────────────────────────
  const bankTxs = await prisma.bankTransaction.findMany({
    where: {
      companyId,
      fecha: { gte: start, lt: end },
    },
    include: {
      // Conciliación uno-a-varios: un movimiento MATCHED sin invoiceId puede
      // estar conciliado con varias facturas vía ConciliacionDetalle — su
      // póliza de liquidación es la misma que la del match 1:1.
      // ...y el invoiceId de cada porción: la liquidación resuelve mirando LA
      // FACTURA (nómina → acreedores; módulo → su CxC), no sólo el sentido.
      conciliacionDetalles: { select: { invoiceId: true } },
    },
  });

  // FASE 2b: a qué liquida cada match — nómina a acreedores, módulo a su CxC.
  const idsConciliados = [
    ...new Set(
      bankTxs.flatMap((tx) => [
        ...(tx.invoiceId ? [tx.invoiceId] : []),
        ...tx.conciliacionDetalles.map((d) => d.invoiceId).filter((x): x is string => !!x),
      ]),
    ),
  ];
  const kindsLiquidacion = await kindPorInvoice(companyId, idsConciliados);

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

    // Pago de impuestos conciliado (movimiento MATCHED ↔ TaxDeclaration vía
    // taxDeclarationId): NO es una liquidación de Clientes/Proveedores — el
    // CFDI nunca pasó por esas cuentas — así que se EXCLUYE de la póliza de
    // liquidación de abajo. Decisión v1 documentada: el enteramiento (cargo a
    // impuestos por pagar / abono a bancos) pertenece al módulo de impuestos,
    // que hoy no provisiona ese pasivo; postear aquí sólo la mitad del asiento
    // rompería la partida doble. Mismo trato que los matches de construcción
    // (Gasto/Raya/Reembolso), que tampoco se postean desde este motor.
    // TODO(impuestos): cuando el módulo de impuestos provisione el pasivo
    // (impuestos por pagar) al cierre, postear aquí la liquidación
    // DR Impuestos por pagar / CR Bancos, espejo del tag IGNORED+TAX_PAYMENT.
    if (tx.status === "MATCHED" && tx.taxDeclarationId) {
      continue; // not posted (v1)
    }

    if (tx.status === "MATCHED" && (tx.invoiceId || tx.conciliacionDetalles.length > 0)) {
      // Settles the clientes/proveedores account that the CFDI originally hit.
      // Aplica igual al match 1:1 (invoiceId) que a la conciliación
      // uno-a-varios (ConciliacionDetalle): la cuenta de liquidación no
      // depende de qué factura(s), sólo del sentido del movimiento.
      const idsDelMatch = tx.invoiceId
        ? [tx.invoiceId]
        : tx.conciliacionDetalles.map((d) => d.invoiceId).filter((x): x is string => !!x);
      const kind = kindComun(kindsLiquidacion, idsDelMatch);
      if (isCredit) {
        // Cobro: abona LA MISMA CxC que el CFDI cargó (módulo o stub).
        const ctaCobro = kind && kind !== "NOMINA" ? (cuentasCxc[kind] ?? accClientes) : accClientes;
        drafts.push({ ...base, chartAccountId: accBancos.id, monto: absAmount, tipo: "CARGO" });
        drafts.push({ ...base, chartAccountId: ctaCobro.id, monto: absAmount, tipo: "ABONO" });
      } else {
        // Pago: nómina liquida ACREEDORES (donde provisionó); lo demás, proveedores.
        const ctaPago = kind === "NOMINA" ? accAcreedoresDiv : accProveedores;
        drafts.push({ ...base, chartAccountId: ctaPago.id, monto: absAmount, tipo: "CARGO" });
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
    // Comprobación autoritativa dentro de la transacción: si el ejercicio se
    // cerró entre el chequeo barato de arriba y este punto, se aborta aquí.
    if (periodRow.status === "CLOSED") throw new PeriodoCerradoError(year, month);

    // Borra SÓLO los asientos que este motor regenera (CFDI/NOMINA/BANCO).
    // Se PRESERVA todo lo demás: APERTURA (saldos iniciales), MANUAL (ajustes
    // del contador), CIERRE (asiento de cierre anual) y las fuentes satélite
    // (CONSTRUCCION/FLOTA/PADEL, posteadas por otros módulos). postMonth nunca
    // vuelve a generar esas fuentes, así que borrarlas destruiría datos.
    await tx.accountingEntry.deleteMany({
      where: { companyId, periodId: periodRow.id, fuente: { in: [...REGENERATED_SOURCES] } },
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

    // Recalcula los totales del periodo sobre TODOS los asientos que quedan
    // (los recién insertados + los preservados: APERTURA/MANUAL/CIERRE/satélite),
    // no sólo los que generó este motor. Así la balanza y el resumen del periodo
    // cuadran incluyendo los ajustes manuales.
    const grouped = await tx.accountingEntry.groupBy({
      by: ["tipo"],
      where: { companyId, periodId: periodRow.id },
      _sum: { monto: true },
      _count: { _all: true },
    });
    let periodCargos = 0;
    let periodAbonos = 0;
    let entriesCount = 0;
    for (const g of grouped) {
      entriesCount += g._count._all;
      if (g.tipo === "CARGO") periodCargos += g._sum.monto ?? 0;
      else if (g.tipo === "ABONO") periodAbonos += g._sum.monto ?? 0;
    }

    // Update period status + summary
    const updated = await tx.accountingPeriod.update({
      where: { id: periodRow.id },
      data: {
        status: "POSTED",
        postedAt: new Date(),
        entriesCount,
        totalCargos: periodCargos,
        totalAbonos: periodAbonos,
      },
    });
    return { updated, periodCargos, periodAbonos, entriesCount };
    // El default de Prisma (5s) alcanza en la red interna de Railway, pero un
    // mes grande re-posteado desde fuera (proxy público, ~100ms por viaje) lo
    // rebasa y la transacción expira A MEDIO WIPE — el rollback salva los
    // datos, pero el re-posteo se vuelve imposible desde terminal. Esto es un
    // cierre mensual, no un hot path: presupuesto generoso.
  }, { maxWait: 30_000, timeout: 300_000 });

  return {
    period: period.updated,
    entriesCreated: drafts.length,
    totalCargos: period.periodCargos,
    totalAbonos: period.periodAbonos,
    warnings,
  };
}

/**
 * Reabre un periodo: lo marca DRAFT y elimina SÓLO los asientos auto-generados
 * (CFDI/NOMINA/BANCO). Se PRESERVAN APERTURA, MANUAL, CIERRE y las fuentes
 * satélite (CONSTRUCCION/FLOTA/PADEL): reabrir un mes no debe destruir los
 * saldos de arranque ni los ajustes capturados a mano. Los totales del periodo
 * se recalculan sobre los asientos que quedan (no se ponen a cero, porque puede
 * subsistir APERTURA/MANUAL).
 */
export async function unpostMonth(companyId: string, year: number, month: number) {
  await prisma.$transaction(async (tx) => {
    const period = await tx.accountingPeriod.findUnique({
      where: { companyId_year_month: { companyId, year, month } },
    });
    if (!period) return;
    // Reabrir un mes suelto de un ejercicio cerrado saltaría el candado: para
    // eso está «Reabrir ejercicio», que es explícito y queda en bitácora.
    if (period.status === "CLOSED") throw new PeriodoCerradoError(year, month);
    await tx.accountingEntry.deleteMany({
      where: { companyId, periodId: period.id, fuente: { in: [...REGENERATED_SOURCES] } },
    });

    const grouped = await tx.accountingEntry.groupBy({
      by: ["tipo"],
      where: { companyId, periodId: period.id },
      _sum: { monto: true },
      _count: { _all: true },
    });
    let totalCargos = 0;
    let totalAbonos = 0;
    let entriesCount = 0;
    for (const g of grouped) {
      entriesCount += g._count._all;
      if (g.tipo === "CARGO") totalCargos += g._sum.monto ?? 0;
      else if (g.tipo === "ABONO") totalAbonos += g._sum.monto ?? 0;
    }

    await tx.accountingPeriod.update({
      where: { id: period.id },
      data: { status: "DRAFT", entriesCount, totalCargos, totalAbonos, postedAt: null },
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
  saldo: number; // signed, period-only movement (kept for P&L / back-compat)
  // Saldos acumulados CON SIGNO para la Balanza COE (Anexo 24):
  saldoInicial: number; // acumulado de movimientos PREVIOS al periodo
  saldoFinal: number; // saldoInicial + movimiento del periodo
};

/**
 * Balanza de comprobación for a given year+month.
 * Returns one row per ChartAccount with period movement (cargos/abonos/saldo)
 * AND the COE opening/closing balances (saldoInicial/saldoFinal), which carry
 * the cumulative balance from all prior periods so the balanza ties out.
 */
export async function balanza(companyId: string, year: number, month: number): Promise<BalanzaRow[]> {
  const [accounts, periodG, priorG] = await Promise.all([
    prisma.chartAccount.findMany({
      where: { companyId, isActive: true },
      select: { id: true, cuentaSAT: true, subcuenta: true, nombre: true, tipo: true, nivel: true, naturaleza: true },
      orderBy: [{ cuentaSAT: "asc" }, { subcuenta: "asc" }],
    }),
    prisma.accountingEntry.groupBy({
      by: ["chartAccountId", "tipo"],
      where: { companyId, year, month },
      _sum: { monto: true },
    }),
    prisma.accountingEntry.groupBy({
      by: ["chartAccountId", "tipo"],
      // Todo lo anterior al periodo: años previos, o el mismo año en meses previos.
      where: { companyId, OR: [{ year: { lt: year } }, { year, month: { lt: month } }] },
      _sum: { monto: true },
    }),
  ]);

  const mov = (groups: typeof periodG) => {
    const m = new Map<string, { cargo: number; abono: number }>();
    for (const g of groups) {
      const e = m.get(g.chartAccountId) ?? { cargo: 0, abono: 0 };
      if (g.tipo === "CARGO") e.cargo += g._sum.monto ?? 0;
      else if (g.tipo === "ABONO") e.abono += g._sum.monto ?? 0;
      m.set(g.chartAccountId, e);
    }
    return m;
  };
  const periodo = mov(periodG);
  const previo = mov(priorG);

  return accounts.map((acc) => {
    const p = periodo.get(acc.id) ?? { cargo: 0, abono: 0 };
    const pre = previo.get(acc.id) ?? { cargo: 0, abono: 0 };
    const naturaleza = (acc.naturaleza as "D" | "A" | null) ?? naturalezaPorTipo(acc.tipo);
    const { saldoInicial, saldoFinal } = saldosCoe({
      naturaleza,
      priorCargos: pre.cargo,
      priorAbonos: pre.abono,
      cargos: p.cargo,
      abonos: p.abono,
    });
    return {
      cuentaSAT: acc.cuentaSAT,
      subcuenta: acc.subcuenta,
      nombre: acc.nombre,
      tipo: acc.tipo,
      nivel: acc.nivel,
      cargos: p.cargo,
      abonos: p.abono,
      saldo: naturaleza === "D" ? p.cargo - p.abono : p.abono - p.cargo,
      saldoInicial,
      saldoFinal,
    };
  });
}

/**
 * Balanza PRELIMINAR para un periodo aún no cerrado. Reconstruye en memoria los
 * asientos derivados de CFDIs (INGRESO / NOMINA / EGRESO) con las MISMAS reglas
 * de partida doble que postMonth, SIN persistir nada y SIN consumir movimientos
 * bancarios (que requieren conciliación y harían fallar el cierre). Los saldos
 * iniciales sí provienen del ledger real (periodos previos ya posteados), para
 * que la balanza preliminar arranque del saldo correcto.
 *
 * Es best-effort: si el catálogo no está sembrado devuelve filas vacías.
 */
export async function balanzaPreview(
  companyId: string,
  year: number,
  month: number
): Promise<BalanzaRow[]> {
  const { start, end } = monthRange(year, month);

  // Movimiento por cuenta (chartAccountId → cargos/abonos) construido en memoria.
  const movByAccount = new Map<string, { cargo: number; abono: number }>();
  const addMov = (chartAccountId: string, tipo: EntryType, monto: number) => {
    const e = movByAccount.get(chartAccountId) ?? { cargo: 0, abono: 0 };
    if (tipo === "CARGO") e.cargo += monto;
    else e.abono += monto;
    movByAccount.set(chartAccountId, e);
  };

  // Cuentas fijas. Si el catálogo no está sembrado, devolvemos balanza base.
  let accClientes: Awaited<ReturnType<typeof resolveAccount>>;
  let accProveedores: Awaited<ReturnType<typeof resolveAccount>>;
  let accIvaTrasladado: Awaited<ReturnType<typeof resolveAccount>>;
  let accIvaAcreditable: Awaited<ReturnType<typeof resolveAccount>>;
  let accVentas: Awaited<ReturnType<typeof resolveAccount>>;
  let accSueldos: Awaited<ReturnType<typeof resolveAccount>>;
  let accIsrPagadoTerceros: Awaited<ReturnType<typeof resolveAccount>>;
  let accIsrRetenidoHonorarios: Awaited<ReturnType<typeof resolveAccount>>;
  let accAcreedoresDiv: Awaited<ReturnType<typeof resolveAccount>>;
  try {
    [
      accClientes,
      accProveedores,
      accIvaTrasladado,
      accIvaAcreditable,
      accVentas,
      accSueldos,
      accIsrPagadoTerceros,
      accIsrRetenidoHonorarios,
      accAcreedoresDiv,
    ] = await Promise.all([
      resolveAccount(companyId, COE_CODES.CLIENTES_NACIONALES),
      resolveAccount(companyId, COE_CODES.PROVEEDORES),
      resolveAccount(companyId, COE_CODES.IVA_TRASLADADO),
      resolveAccount(companyId, COE_CODES.IVA_ACREDITABLE),
      resolveAccount(companyId, COE_CODES.VENTAS_GENERAL),
      resolveAccount(companyId, COE_CODES.SUELDOS_SALARIOS),
      resolveAccount(companyId, COE_CODES.ISR_PAGADO_TERCEROS),
      resolveAccount(companyId, COE_CODES.ISR_RETENIDO_HONORARIOS),
      resolveAccount(companyId, COE_CODES.ACREEDORES_DIVERSOS),
    ]);
  } catch {
    return balanza(companyId, year, month);
  }

  // ── INGRESO (mismas reglas que postMonth) ────────────────────────────────
  const ingresos = await prisma.invoice.findMany({
    where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: start, lt: end } },
    select: { id: true, subtotal: true, total: true, tipoSat: true },
  });
  // FASE 2: mismas reglas de familia que postMonth (venta a 4101-00XX y costo
  // DR 5101-00XX / CR 1301-00XX), para que la balanza preliminar no difiera
  // del cierre.
  const idxFamilia = await cargarIndiceFamilia(companyId);
  const ventasUnidad = await unidadesAmparadas(companyId, ingresos.map((i) => i.id), "venta");
  const cuentasCxc = await cargarCuentasCxc(companyId);
  const modulosIngreso = await conjuntosModulo(companyId, ingresos.map((i) => i.id));
  const taller = await cargarContextoTaller(companyId, ingresos.map((i) => i.id));
  for (const inv of ingresos) {
    const delta = inv.total - inv.subtotal;
    const esEgreso = esComprobanteDeEgreso(inv);
    const unidad = ventasUnidad.get(inv.id);
    const ctaVentaFam = unidad ? cuentaDeFamilia(idxFamilia, MOTOR_VENTAS_UNIDAD, unidad.sufijo) : null;
    const moduloCxc = moduloDeInvoice(inv.id, modulosIngreso);
    addMov(((moduloCxc ? cuentasCxc[moduloCxc] : null) ?? accClientes).id, espejo("CARGO", esEgreso), inv.total);
    const piernasVenta = ctaVentaFam
      ? [{ id: ctaVentaFam.id, monto: inv.subtotal }]
      : (piernasIngresoTaller(inv.id, inv.subtotal, taller)?.map((p) => ({
          id: p.cuenta.id,
          monto: p.monto,
        })) ?? [{ id: accVentas.id, monto: inv.subtotal }]);
    for (const pierna of piernasVenta) addMov(pierna.id, espejo("ABONO", esEgreso), pierna.monto);
    if (delta > 0.005) addMov(accIvaTrasladado.id, espejo("ABONO", esEgreso), delta);
    else if (delta < -0.005) addMov(accIsrPagadoTerceros.id, espejo("CARGO", esEgreso), -delta);
    if (!esEgreso && unidad && ctaVentaFam && unidad.costo > 0.005) {
      const ctaCostoFam = cuentaDeFamilia(idxFamilia, MOTOR_COSTO_UNIDAD, unidad.sufijo);
      const ctaInvFam = cuentaDeFamilia(idxFamilia, MOTOR_INVENTARIO_UNIDAD, unidad.sufijo);
      if (ctaCostoFam && ctaInvFam) {
        addMov(ctaCostoFam.id, "CARGO", unidad.costo);
        addMov(ctaInvFam.id, "ABONO", unidad.costo);
      }
    }
  }

  // ── NOMINA ────────────────────────────────────────────────────────────────
  const nominas = await prisma.invoice.findMany({
    where: { companyId, tipo: "NOMINA", status: "STAMPED", fecha: { gte: start, lt: end } },
    select: { subtotal: true, total: true },
  });
  for (const inv of nominas) {
    const delta = inv.total - inv.subtotal;
    addMov(accSueldos.id, "CARGO", inv.subtotal);
    if (delta < -0.005) addMov(accIsrRetenidoHonorarios.id, "ABONO", -delta);
    else if (delta > 0.005) addMov(accSueldos.id, "CARGO", delta);
    addMov(accAcreedoresDiv.id, "ABONO", inv.total); // provisión de nómina: acreedores
  }

  // ── EGRESO ────────────────────────────────────────────────────────────────
  const egresos = await prisma.invoice.findMany({
    where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: start, lt: end } },
    include: { items: { select: { claveProdServ: true, importe: true } } },
  });
  const comprasUnidad = await unidadesAmparadas(companyId, egresos.map((i) => i.id), "compra");
  const accCache = new Map<string, string | null>();
  async function resolveCachedSafe(code: string): Promise<string | null> {
    if (accCache.has(code)) return accCache.get(code) ?? null;
    try {
      const acc = await resolveAccount(companyId, code);
      accCache.set(code, acc.id);
      return acc.id;
    } catch {
      accCache.set(code, null);
      return null;
    }
  }
  for (const inv of egresos) {
    const delta = inv.total - inv.subtotal;
    // FASE 2: compra de unidad NUEVA → inventario de su familia (1301-00XX),
    // igual que postMonth. Override manual e INVERSION mandan.
    const unidadComprada =
      !inv.overrideCuenta && inv.naturaleza !== "INVERSION" ? comprasUnidad.get(inv.id) : undefined;
    const ctaInvFam = unidadComprada
      ? cuentaDeFamilia(idxFamilia, MOTOR_INVENTARIO_UNIDAD, unidadComprada.sufijo)
      : null;
    const classification = inv.overrideCuenta
      ? { cuenta: inv.overrideCuenta }
      : classifyInvoice(
          inv.items.map((it) => ({ claveProdServ: it.claveProdServ, importe: it.importe }))
        );
    const gastoId = ctaInvFam ? ctaInvFam.id : await resolveCachedSafe(classification.cuenta);
    if (!gastoId) continue;
    const esEgreso = esComprobanteDeEgreso(inv);
    addMov(gastoId, espejo("CARGO", esEgreso), inv.subtotal);
    if (delta > 0.005) addMov(accIvaAcreditable.id, espejo("CARGO", esEgreso), delta);
    else if (delta < -0.005) addMov(accIsrRetenidoHonorarios.id, espejo("ABONO", esEgreso), -delta);
    addMov(accProveedores.id, espejo("ABONO", esEgreso), inv.total);
  }

  // Saldos iniciales del ledger real (periodos previos ya posteados).
  const [accounts, priorG] = await Promise.all([
    prisma.chartAccount.findMany({
      where: { companyId, isActive: true },
      select: { id: true, cuentaSAT: true, subcuenta: true, nombre: true, tipo: true, nivel: true, naturaleza: true },
      orderBy: [{ cuentaSAT: "asc" }, { subcuenta: "asc" }],
    }),
    prisma.accountingEntry.groupBy({
      by: ["chartAccountId", "tipo"],
      where: { companyId, OR: [{ year: { lt: year } }, { year, month: { lt: month } }] },
      _sum: { monto: true },
    }),
  ]);

  const previo = new Map<string, { cargo: number; abono: number }>();
  for (const g of priorG) {
    const e = previo.get(g.chartAccountId) ?? { cargo: 0, abono: 0 };
    if (g.tipo === "CARGO") e.cargo += g._sum.monto ?? 0;
    else if (g.tipo === "ABONO") e.abono += g._sum.monto ?? 0;
    previo.set(g.chartAccountId, e);
  }

  return accounts.map((acc) => {
    const p = movByAccount.get(acc.id) ?? { cargo: 0, abono: 0 };
    const pre = previo.get(acc.id) ?? { cargo: 0, abono: 0 };
    const naturaleza = (acc.naturaleza as "D" | "A" | null) ?? naturalezaPorTipo(acc.tipo);
    const { saldoInicial, saldoFinal } = saldosCoe({
      naturaleza,
      priorCargos: pre.cargo,
      priorAbonos: pre.abono,
      cargos: p.cargo,
      abonos: p.abono,
    });
    return {
      cuentaSAT: acc.cuentaSAT,
      subcuenta: acc.subcuenta,
      nombre: acc.nombre,
      tipo: acc.tipo,
      nivel: acc.nivel,
      cargos: p.cargo,
      abonos: p.abono,
      saldo: naturaleza === "D" ? p.cargo - p.abono : p.abono - p.cargo,
      saldoInicial,
      saldoFinal,
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

// ─────────────────────────────────────────────────────────────────────────────
// PREVIEW (preliminar) — Estado de resultados directo de los CFDIs, SIN crear
// AccountingEntry. Se usa cuando el periodo aún no se ha cerrado (POSTED) para
// que el usuario vea cifras en lugar de "Sin movimientos".
//
// Reutiliza EXACTAMENTE la misma clasificación CFDI→cuenta que el motor de
// posteo (classifyInvoice / overrideCuenta) y la misma cuenta de ingresos
// (Ventas) y de sueldos (Sueldos y salarios), y agrupa por el `tipo`
// (INGRESO / COSTO / GASTO) de la cuenta destino, igual que estadoResultados().
//
// IMPORTANTE: no escribe nada en el ledger. Es seguro de llamar siempre.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Acumulador puro (sin DB) del estado de resultados preliminar. Separado para
 * poder testearlo sin tocar Prisma. Cada aporte trae el `tipo` de la cuenta
 * destino (resuelto fuera) y el monto neto (subtotal, sin impuestos).
 */
export type PreviewContribution = {
  tipo: string; // ChartAccount.tipo (INGRESO | COSTO | GASTO | …)
  cuentaSAT: string;
  subcuenta: string | null;
  nombre: string;
  monto: number;
};

export function buildEstadoResultadosPreview(
  contributions: PreviewContribution[]
): EstadoResultados {
  // Agrupa por (cuentaSAT, subcuenta) sumando montos, igual que la balanza
  // colapsa por cuenta.
  const byKey = new Map<string, EstadoResultadosRow & { tipo: string }>();
  for (const c of contributions) {
    const key = `${c.cuentaSAT}|${c.subcuenta ?? ""}`;
    const seccion =
      c.tipo === "INGRESO" ? "INGRESOS" : c.tipo === "COSTO" ? "COSTOS" : "GASTOS";
    const existing = byKey.get(key);
    if (existing) {
      existing.monto += c.monto;
    } else {
      byKey.set(key, {
        tipo: c.tipo,
        seccion,
        cuentaSAT: c.cuentaSAT,
        subcuenta: c.subcuenta,
        nombre: c.nombre,
        monto: c.monto,
      });
    }
  }

  const ingresos: EstadoResultadosRow[] = [];
  const costos: EstadoResultadosRow[] = [];
  const gastos: EstadoResultadosRow[] = [];

  for (const r of byKey.values()) {
    if (Math.abs(r.monto) < 0.01) continue;
    const row: EstadoResultadosRow = {
      seccion: r.seccion,
      cuentaSAT: r.cuentaSAT,
      subcuenta: r.subcuenta,
      nombre: r.nombre,
      monto: r.monto,
    };
    if (r.tipo === "INGRESO") ingresos.push(row);
    else if (r.tipo === "COSTO") costos.push(row);
    else gastos.push(row);
  }

  const sortByCuenta = (a: EstadoResultadosRow, b: EstadoResultadosRow) =>
    (a.subcuenta ?? a.cuentaSAT).localeCompare(b.subcuenta ?? b.cuentaSAT);
  ingresos.sort(sortByCuenta);
  costos.sort(sortByCuenta);
  gastos.sort(sortByCuenta);

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

/**
 * Estado de resultados PRELIMINAR para un periodo aún no cerrado. Calcula
 * ingresos/costos/gastos directamente de los CFDIs STAMPED del periodo,
 * reutilizando la clasificación del motor de posteo. NO crea AccountingEntry.
 *
 * Cobertura (consistente con postMonth):
 *   - INGRESO: subtotal a Ventas (cuenta de ingresos)
 *   - EGRESO:  subtotal a la cuenta de gasto clasificada (override o auto)
 *   - NOMINA:  subtotal a Sueldos y salarios (gasto)
 * Los impuestos (IVA, retenciones) no afectan el estado de resultados, así que
 * no se incluyen — igual que estadoResultados() los excluye por su `tipo`.
 */
export async function estadoResultadosPreview(
  companyId: string,
  year: number,
  month: number
): Promise<EstadoResultados> {
  const { start, end } = monthRange(year, month);

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true },
  });
  if (!company) throw new Error("Empresa no encontrada");

  const contributions: PreviewContribution[] = [];

  // Resolver cuentas fijas una sola vez (Ventas, Sueldos). Si el catálogo no
  // está sembrado, fallamos suave devolviendo un preview vacío.
  let accVentas: Awaited<ReturnType<typeof resolveAccount>>;
  let accSueldos: Awaited<ReturnType<typeof resolveAccount>>;
  try {
    [accVentas, accSueldos] = await Promise.all([
      resolveAccount(companyId, COE_CODES.VENTAS_GENERAL),
      resolveAccount(companyId, COE_CODES.SUELDOS_SALARIOS),
    ]);
  } catch {
    return buildEstadoResultadosPreview([]);
  }

  // ── INGRESO → Ventas (subtotal) ──────────────────────────────────────────
  const ingresos = await prisma.invoice.findMany({
    where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: start, lt: end } },
    select: { id: true, subtotal: true, tipoSat: true },
  });
  // FASE 2: la venta de una unidad aporta a la cuenta de su FAMILIA y su costo
  // de compra aporta al COSTO de la familia (5101-00XX) — el preview refleja
  // la utilidad bruta real de unidades, no ingreso sin costo.
  const idxFamilia = await cargarIndiceFamilia(companyId);
  const ventasUnidad = await unidadesAmparadas(companyId, ingresos.map((i) => i.id), "venta");
  const taller = await cargarContextoTaller(companyId, ingresos.map((i) => i.id));
  for (const inv of ingresos) {
    // La nota de egreso RESTA ingreso (aplicación de anticipo, devolución,
    // descuento): aporta con signo negativo, no como una venta más.
    const signo = signoDeComprobante(esComprobanteDeEgreso(inv));
    const unidad = ventasUnidad.get(inv.id);
    const ctaVentaFam = unidad ? cuentaDeFamilia(idxFamilia, MOTOR_VENTAS_UNIDAD, unidad.sufijo) : null;
    const ctaVenta = ctaVentaFam ?? accVentas;
    const piernasVenta = ctaVentaFam
      ? null
      : piernasIngresoTaller(inv.id, inv.subtotal, taller);
    for (const pierna of piernasVenta ?? [{ cuenta: ctaVenta, monto: inv.subtotal }]) {
      contributions.push({
        tipo: pierna.cuenta.tipo ?? ctaVenta.tipo,
        cuentaSAT: pierna.cuenta.cuentaSAT,
        subcuenta: pierna.cuenta.subcuenta ?? null,
        nombre: pierna.cuenta.nombre,
        monto: signo * pierna.monto,
      });
    }
    if (signo > 0 && unidad && ctaVentaFam && unidad.costo > 0.005) {
      const ctaCostoFam = cuentaDeFamilia(idxFamilia, MOTOR_COSTO_UNIDAD, unidad.sufijo);
      const ctaInvFam = cuentaDeFamilia(idxFamilia, MOTOR_INVENTARIO_UNIDAD, unidad.sufijo);
      if (ctaCostoFam && ctaInvFam) {
        contributions.push({
          tipo: ctaCostoFam.tipo,
          cuentaSAT: ctaCostoFam.cuentaSAT,
          subcuenta: ctaCostoFam.subcuenta,
          nombre: ctaCostoFam.nombre,
          monto: unidad.costo,
        });
      }
    }
  }

  // ── NOMINA → Sueldos y salarios (subtotal = percepciones brutas) ─────────
  const nominas = await prisma.invoice.findMany({
    where: { companyId, tipo: "NOMINA", status: "STAMPED", fecha: { gte: start, lt: end } },
    select: { subtotal: true },
  });
  for (const inv of nominas) {
    contributions.push({
      tipo: accSueldos.tipo,
      cuentaSAT: accSueldos.cuentaSAT,
      subcuenta: accSueldos.subcuenta,
      nombre: accSueldos.nombre,
      monto: inv.subtotal,
    });
  }

  // ── EGRESO → cuenta de gasto clasificada (subtotal) ──────────────────────
  const egresos = await prisma.invoice.findMany({
    where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: start, lt: end } },
    include: { items: { select: { claveProdServ: true, importe: true } } },
  });

  // Cache de cuentas resueltas; omite (best-effort) egresos cuya clasificación
  // apunte a una cuenta inexistente, sin abortar todo el preview.
  const accCache = new Map<string, Awaited<ReturnType<typeof resolveAccount>> | null>();
  async function resolveCachedSafe(code: string) {
    if (accCache.has(code)) return accCache.get(code) ?? null;
    try {
      const acc = await resolveAccount(companyId, code);
      accCache.set(code, acc);
      return acc;
    } catch {
      accCache.set(code, null);
      return null;
    }
  }

  // FASE 2: la compra de una unidad NUEVA es inventario (activo), no gasto —
  // no aporta al estado de resultados. Su costo aparece al VENDER (arriba).
  const comprasUnidad = await unidadesAmparadas(companyId, egresos.map((i) => i.id), "compra");

  for (const inv of egresos) {
    const unidadComprada =
      !inv.overrideCuenta && inv.naturaleza !== "INVERSION" ? comprasUnidad.get(inv.id) : undefined;
    if (unidadComprada && cuentaDeFamilia(idxFamilia, MOTOR_INVENTARIO_UNIDAD, unidadComprada.sufijo)) {
      continue;
    }
    const classification = inv.overrideCuenta
      ? { cuenta: inv.overrideCuenta }
      : classifyInvoice(
          inv.items.map((it) => ({ claveProdServ: it.claveProdServ, importe: it.importe }))
        );
    const acc = await resolveCachedSafe(classification.cuenta);
    if (!acc) continue;
    contributions.push({
      tipo: acc.tipo,
      cuentaSAT: acc.cuentaSAT,
      subcuenta: acc.subcuenta,
      nombre: acc.nombre,
      monto: signoDeComprobante(esComprobanteDeEgreso(inv)) * inv.subtotal,
    });
  }

  return buildEstadoResultadosPreview(contributions);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-POST condicional — postea SÓLO si el periodo no existe o está en DRAFT.
// Nunca re-postea un periodo POSTED/CLOSED.
//
// Ahora que postMonth() es NO destructivo (sólo regenera CFDI/NOMINA/BANCO y
// preserva APERTURA/MANUAL/CIERRE/satélite), es seguro auto-postear meses que ya
// tengan asientos MANUAL: el re-posteo conserva esos ajustes. Por eso ya no se
// rechazan los periodos con asientos manuales.
// ─────────────────────────────────────────────────────────────────────────────

export type PostMonthIfDraftResult =
  | { posted: true; result: PostMonthResult }
  | { posted: false; reason: "ALREADY_POSTED" | "NO_CFDIS" };

export async function postMonthIfDraft(
  companyId: string,
  year: number,
  month: number
): Promise<PostMonthIfDraftResult> {
  const period = await prisma.accountingPeriod.findUnique({
    where: { companyId_year_month: { companyId, year, month } },
    select: { id: true, status: true },
  });

  // Sólo periodos inexistentes o en DRAFT. Nunca POSTED/CLOSED.
  if (period && period.status !== "DRAFT") {
    return { posted: false, reason: "ALREADY_POSTED" };
  }

  // No tiene sentido postear un mes sin CFDIs (dejaría el periodo POSTED vacío).
  const { start, end } = monthRange(year, month);
  const cfdiCount = await prisma.invoice.count({
    where: {
      companyId,
      status: "STAMPED",
      tipo: { in: ["INGRESO", "EGRESO", "NOMINA"] },
      fecha: { gte: start, lt: end },
    },
  });
  if (cfdiCount === 0) {
    return { posted: false, reason: "NO_CFDIS" };
  }

  const result = await postMonth({ companyId, year, month });
  return { posted: true, result };
}
