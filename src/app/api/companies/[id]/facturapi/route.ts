import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { facturapiAdmin } from "@/lib/facturapi";
import { Readable } from "stream";

type Params = { params: Promise<{ id: string }> };

function base64ToStream(base64: string): NodeJS.ReadableStream {
  const buffer = Buffer.from(base64, "base64");
  const readable = new Readable();
  readable.push(buffer);
  readable.push(null);
  return readable;
}

async function verifyOwner(userId: string, companyId: string) {
  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId, companyId } },
  });
  return member && (member.role === "OWNER" || member.role === "ADMIN");
}

// POST /api/companies/[id]/facturapi
// Auto-setup: create Facturapi org, upload CSD, get test API key
export async function POST(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: companyId } = await params;

  if (!(await verifyOwner(session.user.id, companyId))) {
    return NextResponse.json({ error: "Solo el owner puede configurar Facturapi" }, { status: 403 });
  }

  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  if (!process.env.FACTURAPI_SECRET_KEY || process.env.FACTURAPI_SECRET_KEY === "sk_test_") {
    return NextResponse.json(
      { error: "Configura FACTURAPI_SECRET_KEY en las variables de entorno de Railway" },
      { status: 422 }
    );
  }

  try {
    let orgId = company.facturapiOrgId;

    // 1. Create or reuse Facturapi organization
    if (!orgId) {
      const org = await facturapiAdmin.organizations.create({
        name: company.razonSocial,
      });
      orgId = org.id;
    }

    // 2. Update legal information
    await facturapiAdmin.organizations.updateLegal(orgId, {
      legal_name: company.razonSocial,
      tax_id: company.rfc,
      tax_system: company.regimenFiscal,
      address: {
        zip: company.codigoPostal,
        ...(company.domicilioFiscal ? { street: company.domicilioFiscal } : {}),
      },
    });

    // 3. Upload CSD if stored
    let csdUploaded = false;
    if (company.csdCer && company.csdKey && company.csdPassword) {
      await facturapiAdmin.organizations.uploadCertificate(
        orgId,
        base64ToStream(company.csdCer),
        base64ToStream(company.csdKey),
        company.csdPassword
      );
      csdUploaded = true;
    }

    // 4. Get test API key
    const { api_key } = await facturapiAdmin.organizations.getTestApiKey(orgId);

    // 5. Persist to DB
    const updated = await prisma.company.update({
      where: { id: companyId },
      data: {
        facturapiOrgId: orgId,
        facturapiApiKey: api_key,
      },
      select: {
        id: true,
        facturapiOrgId: true,
        rfc: true,
        razonSocial: true,
      },
    });

    return NextResponse.json({
      ok: true,
      orgId,
      csdUploaded,
      company: updated,
      message: csdUploaded
        ? "Organización creada y CSD subido. Usando clave de prueba."
        : "Organización creada. Sube el CSD para poder timbrar.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error de Facturapi";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PATCH /api/companies/[id]/facturapi
// Manually set the Facturapi API key
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: companyId } = await params;

  if (!(await verifyOwner(session.user.id, companyId))) {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const { apiKey, orgId } = await req.json();
  if (!apiKey) return NextResponse.json({ error: "apiKey requerido" }, { status: 400 });

  const updated = await prisma.company.update({
    where: { id: companyId },
    data: {
      facturapiApiKey: apiKey,
      ...(orgId ? { facturapiOrgId: orgId } : {}),
    },
  });

  return NextResponse.json({ ok: true, company: updated });
}

// DELETE /api/companies/[id]/facturapi
// Disconnect Facturapi from this company
export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: companyId } = await params;

  if (!(await verifyOwner(session.user.id, companyId))) {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  await prisma.company.update({
    where: { id: companyId },
    data: { facturapiApiKey: null, facturapiOrgId: null },
  });

  return NextResponse.json({ ok: true });
}
