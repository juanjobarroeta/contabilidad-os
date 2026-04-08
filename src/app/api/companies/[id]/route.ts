import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { provisionFacturapiOrg } from "@/lib/facturapi";

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
      registroPatronal: true,
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

// PATCH /api/companies/[id] — update FIEL or CSD credentials
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: companyId } = await params;

  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: session.user.id, companyId } },
  });
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const body = await req.json();
  const { fielCer, fielKey, fielPassword, csdCer, csdKey, csdPassword, registroPatronal } = body;

  const data: Record<string, string | null> = {};
  if (fielCer) data.fielCer = fielCer;
  if (fielKey) data.fielKey = fielKey;
  if (fielPassword) data.fielPassword = fielPassword;
  if (csdCer) data.csdCer = csdCer;
  if (csdKey) data.csdKey = csdKey;
  if (csdPassword) data.csdPassword = csdPassword;
  if (registroPatronal !== undefined) {
    // Accept empty string as "clear it"
    data.registroPatronal = registroPatronal?.trim() || null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No hay datos para actualizar" }, { status: 400 });
  }

  await prisma.company.update({ where: { id: companyId }, data });

  // If the CSD just changed, re-run Facturapi provisioning so the org gets
  // the certificate uploaded and a live key issued.
  let facturapi = null;
  if (data.csdCer || data.csdKey || data.csdPassword) {
    facturapi = await provisionFacturapiOrg(companyId);
  }

  return NextResponse.json({ ok: true, facturapi });
}
