import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { getFacturapiClient } from "@/lib/facturapi";
import { recordTimbrado } from "@/lib/costos/record";

// ─────────────────────────────────────────────────────────────────────────────
// Complemento de Pagos (REP — Recibo Electrónico de Pago)
//
// GET  — detect PPD invoices with payments that need REPs
// POST — emit a REP CFDI for a specific payment
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/facturas/complemento-pagos?companyId=xxx
// Returns PPD invoices that have matched bank transactions but no REP emitted
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  // Find PPD invoices (ingreso) that are stamped
  const ppdInvoices = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: "INGRESO",
      metodoPago: "PPD",
      status: "STAMPED",
    },
    select: {
      id: true,
      uuid: true,
      serie: true,
      folio: true,
      fecha: true,
      subtotal: true,
      total: true,
      moneda: true,
      customer: { select: { id: true, rfc: true, razonSocial: true } },
    },
  });

  if (ppdInvoices.length === 0) {
    return NextResponse.json({ pendientes: [], stats: { total: 0, conPago: 0, sinRep: 0 } });
  }

  // For each PPD invoice, find matched bank transactions (payments received)
  const ppdIds = ppdInvoices.map(i => i.id);

  const matchedPayments = await prisma.bankTransaction.findMany({
    where: {
      companyId,
      invoiceId: { in: ppdIds },
      status: "MATCHED",
      monto: { gt: 0 }, // credits = payments received
    },
    select: {
      id: true,
      invoiceId: true,
      fecha: true,
      monto: true,
      descripcion: true,
      referencia: true,
    },
  });

  // Find existing REP CFDIs (tipo PAGO) that reference these invoices
  const existingReps = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: "PAGO",
      status: "STAMPED",
      notas: { in: ppdIds }, // We store the parent invoice ID in notas for REPs
    },
    select: { id: true, notas: true, total: true, uuid: true },
  });
  const repByParent = new Map<string, typeof existingReps>();
  for (const rep of existingReps) {
    const key = rep.notas ?? "";
    if (!repByParent.has(key)) repByParent.set(key, []);
    repByParent.get(key)!.push(rep);
  }

  // Build pending list
  type PendingRep = {
    invoice: typeof ppdInvoices[0];
    payments: typeof matchedPayments;
    existingReps: typeof existingReps;
    totalPaid: number;
    totalReped: number;
    pendingAmount: number;
    needsRep: boolean;
  };

  const pendientes: PendingRep[] = [];

  for (const inv of ppdInvoices) {
    const payments = matchedPayments.filter(p => p.invoiceId === inv.id);
    const reps = repByParent.get(inv.id) ?? [];
    const totalPaid = payments.reduce((s, p) => s + p.monto, 0);
    const totalReped = reps.reduce((s, r) => s + r.total, 0);
    const pendingAmount = Math.round((totalPaid - totalReped) * 100) / 100;

    if (payments.length > 0) {
      pendientes.push({
        invoice: inv,
        payments,
        existingReps: reps,
        totalPaid,
        totalReped,
        pendingAmount,
        needsRep: pendingAmount > 0.01,
      });
    }
  }

  const sinRep = pendientes.filter(p => p.needsRep);

  return NextResponse.json({
    pendientes,
    stats: {
      totalPpd: ppdInvoices.length,
      conPago: pendientes.length,
      sinRep: sinRep.length,
      montoPendiente: sinRep.reduce((s, p) => s + p.pendingAmount, 0),
    },
  });
}

// POST /api/facturas/complemento-pagos
// Emit a REP CFDI for a payment on a PPD invoice
// Body: { companyId, invoiceId, bankTransactionId, monto, fechaPago, formaPago }
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, invoiceId, bankTransactionId, monto, fechaPago, formaPago } = body;

  if (!companyId || !invoiceId) {
    return NextResponse.json({ error: "companyId e invoiceId requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED).
  const gate = await gateEscritura(session.user.id);
  if (gate) return gate;

  // Load the parent PPD invoice
  const parentInv = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId, tipo: "INGRESO", metodoPago: "PPD" },
    include: { customer: true },
  });
  if (!parentInv) return NextResponse.json({ error: "Factura PPD no encontrada" }, { status: 404 });
  if (!parentInv.uuid) return NextResponse.json({ error: "La factura no tiene UUID (no está timbrada)" }, { status: 400 });

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { facturapiApiKey: true, rfc: true },
  });
  if (!company?.facturapiApiKey) {
    return NextResponse.json({ error: "Facturapi no configurado" }, { status: 400 });
  }

  // Determine payment amount
  let paymentAmount = monto ? Number(monto) : null;
  let paymentDate = fechaPago ? new Date(fechaPago) : new Date();

  // If bankTransactionId provided, get amount from the bank tx
  if (bankTransactionId) {
    const bankTx = await prisma.bankTransaction.findFirst({
      where: { id: bankTransactionId, companyId },
      select: { monto: true, fecha: true },
    });
    if (bankTx) {
      paymentAmount = paymentAmount ?? Math.abs(bankTx.monto);
      paymentDate = bankTx.fecha;
    }
  }

  if (!paymentAmount || paymentAmount <= 0) {
    return NextResponse.json({ error: "Monto de pago requerido" }, { status: 400 });
  }

  // Build Facturapi REP payload
  const facturapi = getFacturapiClient(company.facturapiApiKey);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: any = {
    type: "P", // Pago
    customer: parentInv.customer?.facturapiId ?? {
      legal_name: parentInv.customer?.razonSocial ?? "PUBLICO EN GENERAL",
      tax_id: parentInv.customer?.rfc ?? "XAXX010101000",
      tax_system: "601",
      address: { zip: "72830" },
    },
    complements: [
      {
        type: "pago",
        data: {
          payment_form: formaPago ?? "03", // 03 = Transferencia electrónica
          currency: parentInv.moneda ?? "MXN",
          date: paymentDate.toISOString().slice(0, 10),
          amount: paymentAmount,
          related_documents: [
            {
              uuid: parentInv.uuid,
              series: parentInv.serie ?? undefined,
              folio_number: parentInv.folio ? parseInt(parentInv.folio) : undefined,
              currency: parentInv.moneda ?? "MXN",
              last_balance: parentInv.total, // TODO: track remaining balance
              amount: paymentAmount,
              installment: 1, // TODO: track installment number
            },
          ],
        },
      },
    ],
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await facturapi.invoices.create(payload);
    // Costo del timbre del REP (fire-and-forget).
    void recordTimbrado("pago", 1, { companyId, subtipo: "complemento_pagos" });

    // Persist the REP as an Invoice record
    await prisma.invoice.create({
      data: {
        companyId,
        tipo: "PAGO",
        serie: result.series ?? null,
        folio: result.folio_number ? String(result.folio_number) : null,
        fecha: paymentDate,
        formaPago: formaPago ?? "03",
        metodoPago: "PUE",
        usoCfdi: "CP01",
        moneda: parentInv.moneda ?? "MXN",
        subtotal: 0,
        total: paymentAmount,
        status: "STAMPED",
        uuid: result.uuid?.toUpperCase() ?? null, // folio fiscal canónico en MAYÚSCULAS
        facturapiId: result.id ?? null,
        customerId: parentInv.customerId,
        notas: invoiceId, // Link back to parent invoice
      },
    });

    return NextResponse.json({
      ok: true,
      uuid: result.uuid,
      monto: paymentAmount,
      parentUuid: parentInv.uuid,
    });
  } catch (e) {
    console.error("[complemento-pagos] Facturapi error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Error al emitir complemento de pago" },
      { status: 502 }
    );
  }
}
