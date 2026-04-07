import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { provisionFacturapiOrg } from "@/lib/facturapi";

type Params = { params: Promise<{ id: string }> };

async function verifyOwner(userId: string, companyId: string) {
  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId, companyId } },
  });
  return member && (member.role === "OWNER" || member.role === "ADMIN");
}

// POST /api/companies/[id]/facturapi
// Manual retry for Facturapi provisioning. Idempotent — calls the same helper
// that runs automatically on company create + CSD upload.
export async function POST(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: companyId } = await params;

  if (!(await verifyOwner(session.user.id, companyId))) {
    return NextResponse.json({ error: "Solo el owner o admin puede configurar Facturapi" }, { status: 403 });
  }

  const result = await provisionFacturapiOrg(companyId);

  if (!result.ok && result.error) {
    return NextResponse.json({ error: result.error }, { status: 422 });
  }

  return NextResponse.json({
    ok: result.ok,
    orgId: result.orgId,
    csdUploaded: result.csdUploaded,
    hasLiveKey: result.hasLiveKey,
    warning: result.warning,
    message: result.hasLiveKey
      ? "Organización lista con clave live. Ya puedes timbrar CFDIs."
      : result.csdUploaded
      ? "CSD subido. Generando clave live…"
      : "Organización creada. Sube el CSD para emitir CFDIs en producción.",
  });
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
