import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getFacturapiClient } from "@/lib/facturapi";

async function getMember(userId: string, customerId: string) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { companyId: true },
  });
  if (!customer) return null;

  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId, companyId: customer.companyId } },
  });
  return member ? customer : null;
}

// PATCH /api/clientes/[id]
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const customer = await getMember(session.user.id, id);
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const { razonSocial, regimenFiscal, email, phone, domicilio, codigoPostal } = body;

  // Sync update to Facturapi if applicable
  const existing = await prisma.customer.findUnique({ where: { id } });
  if (existing?.facturapiId) {
    const company = await prisma.company.findUnique({
      where: { id: customer.companyId },
      select: { facturapiApiKey: true },
    });
    if (company?.facturapiApiKey) {
      try {
        const fp = getFacturapiClient(company.facturapiApiKey);
        await fp.customers.update(existing.facturapiId, {
          legal_name: razonSocial,
          tax_system: regimenFiscal,
          email,
          address: { zip: codigoPostal, street: domicilio },
        });
      } catch {
        // continue on Facturapi error
      }
    }
  }

  const updated = await prisma.customer.update({
    where: { id },
    data: { razonSocial, regimenFiscal, email, phone, domicilio, codigoPostal },
  });

  return NextResponse.json(updated);
}

// DELETE /api/clientes/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const customer = await getMember(session.user.id, id);
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Check for existing invoices
  const invoiceCount = await prisma.invoice.count({ where: { customerId: id } });
  if (invoiceCount > 0) {
    return NextResponse.json(
      { error: `No se puede eliminar: tiene ${invoiceCount} factura(s) asociada(s)` },
      { status: 409 }
    );
  }

  await prisma.customer.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
