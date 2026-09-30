import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { registrarBitacora } from "@/lib/audit";
import { emitirComplementoPago, prepararRep } from "@/lib/complementos-rep-emit";
import { pendientesRep } from "@/lib/facturas/rep-pendientes";

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

  return NextResponse.json(await pendientesRep(companyId, searchParams.get("customerId")));
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
