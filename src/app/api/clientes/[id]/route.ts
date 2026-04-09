import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getFacturapiClient } from "@/lib/facturapi";
import { parseFacturapiError } from "@/lib/facturapi-errors";
import { getEffectiveCompanyMembership } from "@/lib/authz";

async function getMember(userId: string, customerId: string) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { companyId: true },
  });
  if (!customer) return null;

  const member = await getEffectiveCompanyMembership(userId, customer.companyId);
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

// POST /api/clientes/[id]/sync — push existing customer to Facturapi
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const customerMeta = await getMember(session.user.id, id);
  if (!customerMeta) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const customer = await prisma.customer.findUnique({ where: { id } });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const company = await prisma.company.findUnique({
    where: { id: customerMeta.companyId },
    select: { facturapiApiKey: true, codigoPostal: true },
  });

  if (!company?.facturapiApiKey) {
    return NextResponse.json(
      { error: "Configura primero la clave de Facturapi en Mi Empresa" },
      { status: 422 }
    );
  }

  try {
    const fp = getFacturapiClient(company.facturapiApiKey);

    let facturapiId = customer.facturapiId;

    if (facturapiId) {
      // Update existing
      await fp.customers.update(facturapiId, {
        legal_name: customer.razonSocial,
        tax_system: customer.regimenFiscal,
        email: customer.email ?? undefined,
        address: { zip: customer.codigoPostal ?? company.codigoPostal },
      });
    } else {
      // Create new
      const fpCustomer = await fp.customers.create({
        legal_name: customer.razonSocial,
        tax_id: customer.rfc,
        tax_system: customer.regimenFiscal,
        email: customer.email ?? undefined,
        phone: customer.phone ?? undefined,
        address: {
          zip: customer.codigoPostal ?? company.codigoPostal,
          street: customer.domicilio ?? undefined,
        },
      });
      facturapiId = fpCustomer.id;
    }

    const updated = await prisma.customer.update({
      where: { id },
      data: { facturapiId },
    });

    return NextResponse.json({ ok: true, facturapiId, customer: updated });
  } catch (err) {
    const info = parseFacturapiError(err);
    console.error("[clientes/sync] Facturapi error:", info);
    return NextResponse.json(
      {
        error: info.message,
        kind: info.kind,
        needsReconfigure: info.needsReconfigure,
        details: info.details,
      },
      { status: info.status }
    );
  }
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
