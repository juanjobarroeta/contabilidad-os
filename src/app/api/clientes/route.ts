import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getFacturapiClient } from "@/lib/facturapi";

// GET /api/clientes?companyId=xxx&search=xxx
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json([], { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const search = searchParams.get("search") ?? "";

  if (!companyId) return NextResponse.json([], { status: 400 });

  // Verify membership
  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: session.user.id, companyId } },
  });
  if (!member) return NextResponse.json([], { status: 403 });

  const clientes = await prisma.customer.findMany({
    where: {
      companyId,
      ...(search
        ? {
            OR: [
              { rfc: { contains: search.toUpperCase() } },
              { razonSocial: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: {
      _count: { select: { invoices: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(clientes);
}

// POST /api/clientes
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, rfc, razonSocial, regimenFiscal, email, phone, domicilio, codigoPostal } = body;

  if (!companyId || !rfc || !razonSocial || !regimenFiscal) {
    return NextResponse.json({ error: "Faltan campos requeridos" }, { status: 400 });
  }

  // Verify membership
  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: session.user.id, companyId } },
  });
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Check duplicate RFC
  const existing = await prisma.customer.findUnique({
    where: { companyId_rfc: { companyId, rfc: rfc.toUpperCase() } },
  });
  if (existing) {
    return NextResponse.json({ error: "Ya existe un cliente con ese RFC" }, { status: 409 });
  }

  // Try to sync with Facturapi if company has an API key
  let facturapiId: string | undefined;
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { facturapiApiKey: true, codigoPostal: true },
  });

  if (company?.facturapiApiKey) {
    try {
      const fp = getFacturapiClient(company.facturapiApiKey);
      const fpCustomer = await fp.customers.create({
        legal_name: razonSocial,
        tax_id: rfc.toUpperCase(),
        tax_system: regimenFiscal,
        email: email || undefined,
        phone: phone || undefined,
        address: {
          zip: codigoPostal || company.codigoPostal,
          street: domicilio || undefined,
        },
      });
      facturapiId = fpCustomer.id;
    } catch {
      // Facturapi sync failed — continue without it
    }
  }

  const cliente = await prisma.customer.create({
    data: {
      companyId,
      rfc: rfc.toUpperCase(),
      razonSocial,
      regimenFiscal,
      email,
      phone,
      domicilio,
      codigoPostal,
      facturapiId,
    },
  });

  return NextResponse.json(cliente, { status: 201 });
}
