import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { registrarBitacora } from "@/lib/audit";
import { emitirComplementoPago, prepararRep } from "@/lib/complementos-rep-emit";
import { amparadoPorReps, repsPorFactura } from "@/lib/facturas/reps-amparados";
import { normalizarUuid } from "@/lib/fiscal/uuid";

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

  // Filtro opcional: el hub del cliente pide sólo SUS pendientes de REP.
  const customerId = searchParams.get("customerId");

  // Find PPD invoices (ingreso) that are stamped
  const ppdInvoices = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: "INGRESO",
      metodoPago: "PPD",
      status: "STAMPED",
      ...(customerId ? { customerId } : {}),
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

  const [legacyPayments, detalleAsignaciones] = await Promise.all([
    prisma.bankTransaction.findMany({
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
    }),
    // Conciliación uno-a-varios: la porción asignada a cada factura cuenta
    // como pago recibido (el movimiento deja invoiceId en NULL — sin doble conteo).
    prisma.conciliacionDetalle.findMany({
      where: {
        invoiceId: { in: ppdIds },
        bankTransaction: { companyId, status: "MATCHED", monto: { gt: 0 } },
      },
      select: {
        invoiceId: true,
        montoAsignado: true,
        bankTransaction: { select: { id: true, fecha: true, descripcion: true, referencia: true } },
      },
    }),
  ]);
  const matchedPayments = [
    ...legacyPayments,
    ...detalleAsignaciones.map((d) => ({
      id: d.bankTransaction.id,
      invoiceId: d.invoiceId as string | null,
      fecha: d.bankTransaction.fecha,
      monto: d.montoAsignado,
      descripcion: d.bankTransaction.descripcion,
      referencia: d.bankTransaction.referencia,
    })),
  ];

  // LOS REPS QUE YA AMPARAN CADA FACTURA, POR UUID.
  //
  // Antes se buscaban por `Invoice.notas = <id del padre>`, una convención que
  // sólo escribe esta app al timbrar. El REP que viene del portal del SAT, de
  // otro PAC o del contador anterior llega con `notas = "SAT — emitidos"` y era
  // invisible: su factura salía «sin complemento» para siempre. El enlace real
  // —el UUID del <pago:DoctoRelacionado>— ya estaba en la base.
  const amparado = await amparadoPorReps(prisma, companyId, ppdInvoices.map((i) => i.uuid));
  const repsDe = await repsPorFactura(prisma, companyId, ppdInvoices.map((i) => i.uuid));
  const amparadoDe = (inv: { uuid: string | null }) => (inv.uuid ? amparado.get(normalizarUuid(inv.uuid)) ?? 0 : 0);
  const listaRepsDe = (inv: { uuid: string | null }) => (inv.uuid ? repsDe.get(normalizarUuid(inv.uuid)) ?? [] : []);

  // Build pending list
  type PendingRep = {
    invoice: typeof ppdInvoices[0];
    payments: typeof matchedPayments;
    existingReps: ReturnType<typeof listaRepsDe>;
    totalPaid: number;
    totalReped: number;
    pendingAmount: number;
    needsRep: boolean;
  };

  const pendientes: PendingRep[] = [];

  for (const inv of ppdInvoices) {
    const payments = matchedPayments.filter(p => p.invoiceId === inv.id);
    const reps = listaRepsDe(inv);
    const totalPaid = payments.reduce((s, p) => s + Number(p.monto), 0);
    // Lo amparado es la suma de `impPagado` de cada REP para ESTA factura, no
    // el total del REP: uno solo puede amparar cinco facturas.
    const totalReped = amparadoDe(inv);
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

  // PPD con saldo insoluto y SIN cobro detectado: los despachos que no cargan
  // estados de cuenta nunca tendrían filas arriba (todo depende de la
  // conciliación). Aquí el saldo se deriva de los REPs ya emitidos: lo que
  // falta por complementar aunque el banco no esté conciliado. El cobro se
  // registra a mano desde el centro (monto/fecha) y el motor calcula la
  // parcialidad igual.
  const conPagoIds = new Set(matchedPayments.map((p) => p.invoiceId));
  const sinCobroDetectado = ppdInvoices
    .map((inv) => {
      const totalReped = amparadoDe(inv);
      return {
        invoice: inv,
        totalReped,
        saldoInsoluto: Math.round((Number(inv.total) - totalReped) * 100) / 100,
      };
    })
    .filter((x) => !conPagoIds.has(x.invoice.id) && x.saldoInsoluto > 0.01)
    .sort((a, b) => new Date(b.invoice.fecha).getTime() - new Date(a.invoice.fecha).getTime());

  return NextResponse.json({
    pendientes,
    sinCobroDetectado,
    stats: {
      totalPpd: ppdInvoices.length,
      conPago: pendientes.length,
      sinRep: sinRep.length,
      sinCobro: sinCobroDetectado.length,
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

  // preview:true → SOLO calcula la parcialidad y los saldos (prepararRep), sin
  // timbrar ni escribir nada. Es lo que ve el contador antes de confirmar, así
  // que no pasa por el gate de escritura ni deja bitácora.
  if (body.preview === true) {
    const prev = await prepararRep({ companyId, invoiceId, bankTransactionId, monto, fechaPago, formaPago });
    if (!prev.ok) return NextResponse.json({ error: prev.error }, { status: prev.status });
    return NextResponse.json({ ok: true, preview: prev.preview });
  }

  // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED).
  const gate = await gateEscritura(session.user.id);
  if (gate) return gate;

  // Toda la validación fiscal, el timbrado y la persistencia consistente viven en
  // el motor (parcialidad correcta, saldos, desglose de IVA, PagoDoctoRelacionado).
  const result = await emitirComplementoPago({ companyId, invoiceId, bankTransactionId, monto, fechaPago, formaPago });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  registrarBitacora({
    accion: "complemento.emitir",
    userId: session.user.id,
    companyId,
    entidad: "Invoice",
    entidadId: invoiceId,
    detalle: { uuid: result.uuid, monto: result.monto, parcialidad: result.numParcialidad, parentUuid: result.parentUuid },
  });

  return NextResponse.json({ ok: true, uuid: result.uuid, monto: result.monto, parentUuid: result.parentUuid, numParcialidad: result.numParcialidad });
}
