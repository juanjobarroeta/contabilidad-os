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
