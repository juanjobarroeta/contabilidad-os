import { prisma } from "@/lib/prisma";
import {
  detectComplementosPendientes,
  detectComplementosRecibidosPendientes,
} from "@/lib/complementos";
import { computeTaxPosition } from "@/lib/impuestos";
import { getSatSyncStatus } from "@/lib/sat-status";
import { signFileToken, publicBaseUrl } from "@/lib/facturas/file-token";
import { previewTimbrar } from "@/lib/facturas/preview-timbrar";
import { listUnmatched, scoreCandidates } from "@/lib/conciliacion";
import { stagePendingConciliar } from "@/lib/whatsapp/pending-action";

type ToolInput = Record<string, unknown>;

/** Extra context for write tools (e.g. which WhatsApp conversation staged it). */
export type ToolContext = { conversationId?: string };

export async function executeToolCall(
  toolName: string,
  input: ToolInput,
  companyId: string,
  context: ToolContext = {}
): Promise<string> {
  switch (toolName) {
    case "preview_factura":
      return previewTimbrar(input, companyId, context.conversationId);
    case "list_unmatched_transactions":
      return JSON.stringify(
        await listUnmatched(companyId, typeof input.limit === "number" ? input.limit : 10)
      );
    case "preview_conciliacion":
      return previewConciliacion(input, companyId, context.conversationId);
    case "query_invoices":
      return queryInvoices(input, companyId);
    case "query_bank_transactions":
      return queryBankTransactions(input, companyId);
    case "query_tax_declarations":
      return queryTaxDeclarations(input, companyId);
    case "query_dashboard_kpis":
      return queryDashboardKpis(companyId);
    case "query_customers":
      return queryCustomers(input, companyId);
    case "query_employees":
      return queryEmployees(input, companyId);
    case "query_obligations":
      return queryObligations(input, companyId);
    case "categorize_transaction":
      return categorizeTransaction(input, companyId);
    case "suggest_reconciliation_match":
      return suggestReconciliationMatch(input, companyId);
    case "analyze_anomalies":
      return analyzeAnomalies(input, companyId);
    case "query_complementos_pendientes":
      return JSON.stringify(await detectComplementosPendientes(companyId));
    case "query_complementos_recibidos_pendientes":
      return JSON.stringify(await detectComplementosRecibidosPendientes(companyId));
    case "query_sat_sync_status":
      return JSON.stringify(await getSatSyncStatus(companyId));
    case "get_invoice_files":
      return getInvoiceFiles(input, companyId);
    case "query_tax_position": {
      const now = new Date();
      const year = typeof input.year === "number" ? input.year : now.getFullYear();
      const month = typeof input.month === "number" ? input.month : now.getMonth() + 1;
      return JSON.stringify(await computeTaxPosition(companyId, year, month));
    }
    default:
      return JSON.stringify({ error: `Herramienta desconocida: ${toolName}` });
  }
}

// ─── query_invoices ──────────────────────────────────────────────────────────

async function previewConciliacion(
  input: ToolInput,
  companyId: string,
  conversationId?: string
): Promise<string> {
  if (!conversationId) {
    return JSON.stringify({ error: "La conciliación con confirmación solo está disponible por WhatsApp." });
  }
  const txId = String(input.transaction_id ?? "");
  const invoiceId = String(input.invoice_id ?? "");
  if (!txId || !invoiceId) {
    return JSON.stringify({ error: "Faltan transaction_id e invoice_id." });
  }

  // Validate both belong to the company and build a preview.
  const { tx, candidates } = await scoreCandidates(txId, companyId);
  if (!tx) return JSON.stringify({ error: "Movimiento no encontrado." });
  const cand = candidates.find((c) => c.invoiceId === invoiceId);

  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId },
    select: { id: true, uuid: true, total: true, fecha: true, customer: { select: { razonSocial: true } } },
  });
  if (!inv) return JSON.stringify({ error: "Factura no encontrada para esta empresa." });

  const MXN = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
  const montoMatch = Math.abs(tx.monto).toFixed(2) === inv.total.toFixed(2);
  const preview =
    `Movimiento: ${tx.fecha} · ${tx.descripcion} · ${MXN(tx.monto)}\n` +
    `Factura: ${inv.customer?.razonSocial ?? "—"} · ${MXN(inv.total)} · ${inv.fecha.toISOString().slice(0, 10)}\n` +
    `${montoMatch ? "Los montos coinciden ✅" : "⚠️ Los montos NO coinciden exactamente — revisa."}`;

  const { code } = await stagePendingConciliar(conversationId, companyId, { txId, invoiceId }, preview);
  return JSON.stringify({
    staged: true,
    preview,
    confianza: cand?.confidence ?? "baja",
    instruccion_para_el_asistente:
      `Muestra el resumen y pide al usuario que confirme con el código ${code} para conciliar, o 'cancelar'. ` +
      `NO digas que ya se concilió — solo ocurre cuando el usuario envía el código.`,
    codigo_confirmacion: code,
  });
}

async function getInvoiceFiles(input: ToolInput, companyId: string): Promise<string> {
  const where: Record<string, unknown> = { companyId };
  if (input.uuid) where.uuid = String(input.uuid).toUpperCase();
  if (input.date_from || input.date_to) {
    where.fecha = {
      ...(input.date_from ? { gte: new Date(String(input.date_from)) } : {}),
      ...(input.date_to ? { lte: new Date(`${input.date_to}T23:59:59`) } : {}),
    };
  }
  if (input.cliente) {
    where.customer = {
      OR: [
        { razonSocial: { contains: String(input.cliente), mode: "insensitive" } },
        { rfc: { contains: String(input.cliente).toUpperCase() } },
      ],
    };
  }
  const limit = typeof input.limit === "number" ? Math.min(input.limit, 20) : 10;

  const invoices = await prisma.invoice.findMany({
    where,
    select: {
      id: true, uuid: true, fecha: true, total: true,
      rawXml: true, facturapiId: true,
      customer: { select: { razonSocial: true } },
    },
    orderBy: { fecha: "desc" },
    take: limit,
  });

  if (invoices.length === 0) {
    return JSON.stringify({ count: 0, message: "No encontré facturas con esos criterios." });
  }

  const base = publicBaseUrl();
  const files = invoices.map((inv) => {
    const hasXml = !!inv.rawXml;
    const hasPdf = !!inv.facturapiId;
    return {
      uuid: inv.uuid,
      fecha: inv.fecha.toISOString().slice(0, 10),
      cliente: inv.customer?.razonSocial ?? null,
      total: inv.total,
      xmlUrl: hasXml ? `${base}/api/facturas/${inv.id}/file?format=xml&token=${signFileToken(inv.id, "xml")}` : null,
      pdfUrl: hasPdf ? `${base}/api/facturas/${inv.id}/file?format=pdf&token=${signFileToken(inv.id, "pdf")}` : null,
      nota: !hasXml ? "XML no disponible (factura importada antes de guardarse el archivo)" : (!hasPdf ? "Solo XML disponible (las facturas del SAT no tienen PDF)" : undefined),
    };
  });

  return JSON.stringify({
    count: files.length,
    files,
    instrucciones: "Comparte los enlaces con el usuario. Son temporales (30 min). Si falta el XML, explícale que esa factura se importó antes de que guardáramos el archivo.",
  });
}

async function queryInvoices(input: ToolInput, companyId: string) {
  const where: Record<string, unknown> = { companyId };

  if (input.tipo) where.tipo = input.tipo;
  if (input.status) where.status = input.status;
  if (input.date_from || input.date_to) {
    where.fecha = {
      ...(input.date_from ? { gte: new Date(input.date_from as string) } : {}),
      ...(input.date_to ? { lte: new Date(input.date_to as string) } : {}),
    };
  }
  if (input.customer_rfc) {
    where.customer = { rfc: input.customer_rfc };
  }

  if (input.summary_only) {
    const [agg, count] = await Promise.all([
      prisma.invoice.aggregate({ where, _sum: { subtotal: true, total: true, totalImpuestos: true } }),
      prisma.invoice.count({ where }),
    ]);
    return JSON.stringify({
      count,
      subtotal: agg._sum.subtotal ?? 0,
      total: agg._sum.total ?? 0,
      totalImpuestos: agg._sum.totalImpuestos ?? 0,
    });
  }

  const invoices = await prisma.invoice.findMany({
    where,
    include: { customer: { select: { razonSocial: true, rfc: true } } },
    orderBy: { fecha: "desc" },
    take: Math.min((input.limit as number) || 20, 50),
  });

  return JSON.stringify(
    invoices.map((inv) => ({
      id: inv.id,
      tipo: inv.tipo,
      fecha: inv.fecha.toISOString().substring(0, 10),
      cliente: inv.customer?.razonSocial ?? "—",
      clienteRfc: inv.customer?.rfc ?? "—",
      subtotal: inv.subtotal,
      total: inv.total,
      status: inv.status,
      uuid: inv.uuid,
      formaPago: inv.formaPago,
      metodoPago: inv.metodoPago,
    }))
  );
}

// ─── query_bank_transactions ─────────────────────────────────────────────────

async function queryBankTransactions(input: ToolInput, companyId: string) {
  const where: Record<string, unknown> = { companyId };

  if (input.bank_account_id) where.bankAccountId = input.bank_account_id;
  if (input.status) where.status = input.status;
  if (input.tipo) where.tipo = input.tipo;
  if (input.date_from || input.date_to) {
    where.fecha = {
      ...(input.date_from ? { gte: new Date(input.date_from as string) } : {}),
      ...(input.date_to ? { lte: new Date(input.date_to as string) } : {}),
    };
  }
  if (input.monto_min !== undefined || input.monto_max !== undefined) {
    where.monto = {
      ...(input.monto_min !== undefined ? { gte: input.monto_min } : {}),
      ...(input.monto_max !== undefined ? { lte: input.monto_max } : {}),
    };
  }

  if (input.summary_only) {
    const [agg, count] = await Promise.all([
      prisma.bankTransaction.aggregate({ where, _sum: { monto: true } }),
      prisma.bankTransaction.count({ where }),
    ]);
    return JSON.stringify({ count, totalMonto: agg._sum.monto ?? 0 });
  }

  const txs = await prisma.bankTransaction.findMany({
    where,
    include: {
      bankAccount: { select: { banco: true, nombre: true } },
      invoice: { select: { uuid: true, total: true, tipo: true } },
      supplier: { select: { razonSocial: true, rfc: true } },
    },
    orderBy: { fecha: "desc" },
    take: Math.min((input.limit as number) || 20, 50),
  });

  return JSON.stringify(
    txs.map((tx) => ({
      id: tx.id,
      fecha: tx.fecha.toISOString().substring(0, 10),
      descripcion: tx.descripcion,
      referencia: tx.referencia,
      monto: tx.monto,
      tipo: tx.tipo,
      status: tx.status,
      banco: tx.bankAccount.banco,
      cuenta: tx.bankAccount.nombre,
      invoiceUuid: tx.invoice?.uuid,
      supplier: tx.supplier?.razonSocial,
    }))
  );
}

// ─── query_tax_declarations ──────────────────────────────────────────────────

async function queryTaxDeclarations(input: ToolInput, companyId: string) {
  const where: Record<string, unknown> = { companyId };
  if (input.tipo) where.tipo = input.tipo;
  if (input.periodo) where.periodo = input.periodo;

  const declarations = await prisma.taxDeclaration.findMany({
    where,
    orderBy: { periodo: "desc" },
    take: Math.min((input.limit as number) || 10, 20),
  });

  return JSON.stringify(
    declarations.map((d) => ({
      id: d.id,
      tipo: d.tipo,
      periodo: d.periodo,
      status: d.status,
      ivaTrasladadoCobrado: d.ivaTrasladadoCobrado,
      ivaAcreditableGastado: d.ivaAcreditableGastado,
      ivaPagar: d.ivaPagar,
      isrIngresos: d.isrIngresos,
      isrPagar: d.isrPagar,
      fechaPresentacion: d.fechaPresentacion?.toISOString().substring(0, 10),
    }))
  );
}

// ─── query_dashboard_kpis ────────────────────────────────────────────────────

async function queryDashboardKpis(companyId: string) {
  const now = new Date();
  const monthFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthTo = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const [ingresos, gastos, ivaTrasladado, ivaAcreditable, unmatched, obligations] =
    await Promise.all([
      prisma.invoice.aggregate({
        where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: monthFrom, lt: monthTo } },
        _sum: { subtotal: true, total: true },
        _count: { id: true },
      }),
      prisma.invoice.aggregate({
        where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: monthFrom, lt: monthTo } },
        _sum: { subtotal: true, total: true },
        _count: { id: true },
      }),
      prisma.invoiceTax.aggregate({
        where: {
          invoice: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: monthFrom, lt: monthTo } },
          tipo: "IVA",
          retencion: false,
        },
        _sum: { importe: true },
      }),
      prisma.invoiceTax.aggregate({
        where: {
          invoice: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: monthFrom, lt: monthTo } },
          tipo: "IVA",
          retencion: false,
        },
        _sum: { importe: true },
      }),
      prisma.bankTransaction.count({
        where: { companyId, status: "UNMATCHED" },
      }),
      prisma.companyObligation.findMany({
        where: { companyId, activa: true },
      }),
    ]);

  const ingresosDelMes = ingresos._sum.subtotal ?? 0;
  const gastosDelMes = gastos._sum.subtotal ?? 0;
  const ivaTrasl = ivaTrasladado._sum.importe ?? 0;
  const ivaAcred = ivaAcreditable._sum.importe ?? 0;

  return JSON.stringify({
    periodo: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
    ingresosDelMes,
    gastosDelMes,
    utilidadBruta: ingresosDelMes - gastosDelMes,
    ivaTrasladado: ivaTrasl,
    ivaAcreditable: ivaAcred,
    ivaEstimadoPagar: ivaTrasl - ivaAcred,
    facturasEmitidas: ingresos._count.id,
    facturasRecibidas: gastos._count.id,
    transaccionesSinConciliar: unmatched,
    obligacionesActivas: obligations.length,
  });
}

// ─── query_customers ─────────────────────────────────────────────────────────

async function queryCustomers(input: ToolInput, companyId: string) {
  const where: Record<string, unknown> = { companyId };
  if (input.search) {
    where.OR = [
      { rfc: { contains: input.search as string, mode: "insensitive" } },
      { razonSocial: { contains: input.search as string, mode: "insensitive" } },
    ];
  }

  const customers = await prisma.customer.findMany({
    where,
    orderBy: { razonSocial: "asc" },
    take: Math.min((input.limit as number) || 20, 50),
  });

  return JSON.stringify(
    customers.map((c) => ({
      id: c.id,
      rfc: c.rfc,
      razonSocial: c.razonSocial,
      regimenFiscal: c.regimenFiscal,
      email: c.email,
      codigoPostal: c.codigoPostal,
    }))
  );
}

// ─── query_employees ─────────────────────────────────────────────────────────

async function queryEmployees(input: ToolInput, companyId: string) {
  const where: Record<string, unknown> = { companyId };

  const activeOnly = input.active_only !== false;
  if (activeOnly) where.isActive = true;

  if (input.search) {
    where.OR = [
      { nombre: { contains: input.search as string, mode: "insensitive" } },
      { apellidoPaterno: { contains: input.search as string, mode: "insensitive" } },
      { rfc: { contains: input.search as string, mode: "insensitive" } },
    ];
  }

  const employees = await prisma.employee.findMany({
    where,
    orderBy: { nombre: "asc" },
    take: Math.min((input.limit as number) || 20, 50),
  });

  return JSON.stringify(
    employees.map((e) => ({
      id: e.id,
      nombre: `${e.nombre} ${e.apellidoPaterno} ${e.apellidoMaterno ?? ""}`.trim(),
      rfc: e.rfc,
      curp: e.curp,
      nss: e.nss,
      fechaIngreso: e.fechaIngreso.toISOString().substring(0, 10),
      salarioDiario: e.salarioDiario,
      sdi: e.salarioDiarioIntegrado,
      isActive: e.isActive,
    }))
  );
}

// ─── query_obligations ───────────────────────────────────────────────────────

async function queryObligations(input: ToolInput, companyId: string) {
  const where: Record<string, unknown> = { companyId };
  if (input.active_only !== false) where.activa = true;

  const obligations = await prisma.companyObligation.findMany({
    where,
    orderBy: { tipo: "asc" },
  });

  return JSON.stringify(
    obligations.map((ob) => ({
      id: ob.id,
      tipo: ob.tipo,
      descripcion: ob.descripcion,
      periodicidad: ob.periodicidad,
      diaVencimiento: ob.diaVencimiento,
      mesVencimiento: ob.mesVencimiento,
      activa: ob.activa,
      fuente: ob.fuente,
    }))
  );
}

// ─── categorize_transaction ──────────────────────────────────────────────────

async function categorizeTransaction(input: ToolInput, companyId: string) {
  // Fetch the company's chart of accounts for context
  const accounts = await prisma.chartAccount.findMany({
    where: { companyId, isActive: true },
    orderBy: { cuentaSAT: "asc" },
  });

  return JSON.stringify({
    transaction: {
      descripcion: input.transaction_description,
      monto: input.monto,
      tipo: input.tipo,
    },
    available_accounts: accounts.map((a) => ({
      cuentaSAT: a.cuentaSAT,
      subcuenta: a.subcuenta,
      nombre: a.nombre,
      tipo: a.tipo,
    })),
    instruction:
      "Con base en la descripción de la transacción y las cuentas disponibles, sugiere la cuenta contable más apropiada y explica por qué.",
  });
}

// ─── suggest_reconciliation_match ────────────────────────────────────────────

async function suggestReconciliationMatch(input: ToolInput, companyId: string) {
  const tx = await prisma.bankTransaction.findFirst({
    where: { id: input.transaction_id as string, companyId },
    include: { bankAccount: { select: { banco: true, nombre: true } } },
  });

  if (!tx) return JSON.stringify({ error: "Transacción no encontrada" });

  const absAmount = Math.abs(tx.monto);
  const tolerance = absAmount * 0.02; // 2% tolerance

  // Find invoices with similar amounts around the same date
  const candidateInvoices = await prisma.invoice.findMany({
    where: {
      companyId,
      status: "STAMPED",
      total: { gte: absAmount - tolerance, lte: absAmount + tolerance },
      fecha: {
        gte: new Date(tx.fecha.getTime() - 30 * 86400000),
        lte: new Date(tx.fecha.getTime() + 30 * 86400000),
      },
    },
    include: { customer: { select: { razonSocial: true, rfc: true } } },
    take: 10,
  });

  // Find suppliers with matching names in description
  const suppliers = await prisma.supplier.findMany({
    where: { companyId },
    take: 100,
  });

  const matchingSuppliers = suppliers.filter(
    (s) =>
      tx.descripcion.toUpperCase().includes(s.razonSocial.toUpperCase()) ||
      tx.descripcion.toUpperCase().includes(s.rfc.toUpperCase())
  );

  return JSON.stringify({
    transaction: {
      id: tx.id,
      fecha: tx.fecha.toISOString().substring(0, 10),
      descripcion: tx.descripcion,
      monto: tx.monto,
      tipo: tx.tipo,
      banco: tx.bankAccount.banco,
    },
    candidate_invoices: candidateInvoices.map((inv) => ({
      id: inv.id,
      uuid: inv.uuid,
      tipo: inv.tipo,
      fecha: inv.fecha.toISOString().substring(0, 10),
      total: inv.total,
      cliente: inv.customer?.razonSocial,
      clienteRfc: inv.customer?.rfc,
    })),
    matching_suppliers: matchingSuppliers.map((s) => ({
      id: s.id,
      rfc: s.rfc,
      razonSocial: s.razonSocial,
    })),
  });
}

// ─── analyze_anomalies ───────────────────────────────────────────────────────

async function analyzeAnomalies(input: ToolInput, companyId: string) {
  const days = (input.days as number) || 30;
  const since = new Date();
  since.setDate(since.getDate() - days);

  const [invoices, transactions] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId, status: "STAMPED", fecha: { gte: since } },
      include: { customer: { select: { razonSocial: true, rfc: true } } },
      orderBy: { fecha: "desc" },
    }),
    prisma.bankTransaction.findMany({
      where: { companyId, fecha: { gte: since } },
      orderBy: { fecha: "desc" },
    }),
  ]);

  // Detect duplicate amounts in invoices
  const amountMap = new Map<number, typeof invoices>();
  for (const inv of invoices) {
    const key = inv.total;
    if (!amountMap.has(key)) amountMap.set(key, []);
    amountMap.get(key)!.push(inv);
  }
  const duplicateAmounts = Array.from(amountMap.entries())
    .filter(([, invs]) => invs.length > 1)
    .map(([amount, invs]) => ({
      amount,
      count: invs.length,
      invoices: invs.map((i) => ({
        id: i.id,
        uuid: i.uuid,
        fecha: i.fecha.toISOString().substring(0, 10),
        cliente: i.customer?.razonSocial,
      })),
    }));

  // Detect unusually high transactions (> 3 std deviations)
  const amounts = transactions.map((t) => Math.abs(t.monto));
  const mean = amounts.length ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0;
  const std = amounts.length
    ? Math.sqrt(amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length)
    : 0;
  const threshold = mean + 3 * std;
  const unusualTransactions = transactions
    .filter((t) => Math.abs(t.monto) > threshold && threshold > 0)
    .map((t) => ({
      id: t.id,
      fecha: t.fecha.toISOString().substring(0, 10),
      descripcion: t.descripcion,
      monto: t.monto,
      tipo: t.tipo,
    }));

  // Unmatched transactions count
  const unmatchedCount = transactions.filter((t) => t.status === "UNMATCHED").length;

  // ── Fiscal-specific checks ────────────────────────────────────────────────
  // Cancelled CFDIs in the window — these must NOT be counted in IVA/ISR, a
  // common error when a CFDI is cancelled after the declaration was computed.
  const cancelledCount = await prisma.invoice.count({
    where: { companyId, status: "CANCELLED", fecha: { gte: since } },
  });

  // Complementos de pago: both directions (accurate, deadline-aware).
  const [emitidos, recibidos] = await Promise.all([
    detectComplementosPendientes(companyId),
    detectComplementosRecibidosPendientes(companyId),
  ]);

  return JSON.stringify({
    periodo: `Últimos ${days} días`,
    totalFacturas: invoices.length,
    totalTransacciones: transactions.length,
    duplicateAmounts: duplicateAmounts.slice(0, 10),
    unusualTransactions: unusualTransactions.slice(0, 10),
    unmatchedTransactions: unmatchedCount,
    cfdisCancelados: cancelledCount,
    complementosQueDebesEmitir: {
      total: emitidos.stats.totalPendientes,
      vencidos: emitidos.stats.vencidos,
      montoPendiente: emitidos.stats.montoPendiente,
    },
    complementosQueTeDebenProveedores: {
      total: recibidos.stats.totalPendientes,
      vencidos: recibidos.stats.vencidos,
      ejemplos: recibidos.pendientes.slice(0, 5).map((p) => ({
        proveedor: p.proveedor,
        totalPagado: p.totalPagado,
        fechaLimite: p.fechaLimite,
        urgencia: p.urgencia,
      })),
    },
    stats: { mean: Math.round(mean), stdDev: Math.round(std), threshold: Math.round(threshold) },
  });
}
