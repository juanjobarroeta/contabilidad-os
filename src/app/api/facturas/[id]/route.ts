import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getFacturapiClient } from "@/lib/facturapi";
import { getEffectiveCompanyMembership } from "@/lib/authz";

// POST /api/facturas/[id]/cancel — handled via DELETE for simplicity
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { company: true },
  });

  if (!invoice) return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });

  // Verify membership
  const member = await getEffectiveCompanyMembership(session.user.id, invoice.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  if (invoice.status === "CANCELLED") {
    return NextResponse.json({ error: "La factura ya está cancelada" }, { status: 409 });
  }

  // Cancel in Facturapi if stamped
  if (invoice.facturapiId && invoice.company.facturapiApiKey) {
    try {
      const fp = getFacturapiClient(invoice.company.facturapiApiKey);
      await fp.invoices.cancel(invoice.facturapiId);
    } catch {
      // Log but continue — mark as cancelled in DB either way
    }
  }

  const updated = await prisma.invoice.update({
    where: { id },
    data: { status: "CANCELLED" },
  });

  return NextResponse.json(updated);
}

// PATCH /api/facturas/[id] — update contador fields on an invoice.
// Currently only `overrideCuenta` (the auto-classification override).
//
// The override is the SAT subcuenta code (e.g. "601.15") that should be
// used by the posting engine instead of whatever classifyInvoice() returns
// for this invoice. Set to empty/null to clear the override and re-enable
// automatic classification.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    select: { id: true, companyId: true },
  });
  if (!invoice) return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, invoice.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const data: { overrideCuenta?: string | null } = {};
  if ("overrideCuenta" in body) {
    const v = body.overrideCuenta;
    if (v === null || v === "" || v === undefined) {
      data.overrideCuenta = null;
    } else if (typeof v === "string" && v.trim().length > 0) {
      // Validate the cuenta exists in this company's chart of accounts
      const exists = await prisma.chartAccount.findFirst({
        where: {
          companyId: invoice.companyId,
          OR: [{ subcuenta: v.trim() }, { cuentaSAT: v.trim(), subcuenta: null }],
        },
      });
      if (!exists) {
        return NextResponse.json(
          { error: `La cuenta "${v}" no existe en el catálogo de la empresa` },
          { status: 400 }
        );
      }
      data.overrideCuenta = v.trim();
    } else {
      return NextResponse.json({ error: "overrideCuenta inválido" }, { status: 400 });
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No hay cambios" }, { status: 400 });
  }

  const updated = await prisma.invoice.update({
    where: { id },
    data,
  });
  return NextResponse.json(updated);
}
