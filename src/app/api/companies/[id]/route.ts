import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

// GET /api/companies/[id]
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: companyId } = await params;

  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: session.user.id, companyId } },
  });
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      rfc: true,
      razonSocial: true,
      regimenFiscal: true,
      codigoPostal: true,
      domicilioFiscal: true,
      nombreComercial: true,
      email: true,
      telefono: true,
      actividadEconomica: true,
      facturapiOrgId: true,
      facturapiApiKey: true,
      csdCer: true,
      csdKey: true,
      csdVigencia: true,
      fielCer: true,
      fielKey: true,
      fielVigencia: true,
      isActive: true,
      createdAt: true,
    },
  });

  if (!company) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Mask the actual cert content for security — just signal presence
  return NextResponse.json({
    ...company,
    csdCer: company.csdCer ? "[stored]" : null,
    csdKey: company.csdKey ? "[stored]" : null,
    fielCer: company.fielCer ? "[stored]" : null,
    fielKey: company.fielKey ? "[stored]" : null,
  });
}
