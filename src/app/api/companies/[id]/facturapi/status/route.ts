import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { facturapiAdmin } from "@/lib/facturapi";
import { getEffectiveCompanyMembership } from "@/lib/authz";

type Params = { params: Promise<{ id: string }> };

// GET /api/companies/[id]/facturapi/status
// Returns the live status of the company's Facturapi org:
//   { isProductionReady, pendingSteps[], hasCertificate, taxId, dashboardUrl }
// Used by the empresa page to show the user exactly what's blocking timbrado.
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: companyId } = await params;

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { facturapiOrgId: true },
  });
  if (!company?.facturapiOrgId) {
    return NextResponse.json({
      orgId: null,
      isProductionReady: false,
      pendingSteps: [],
      message: "Organización no provisionada en Facturapi",
    });
  }

  try {
    const org = await facturapiAdmin.organizations.retrieve(company.facturapiOrgId);
    const o = org as unknown as {
      id: string;
      is_production_ready?: boolean;
      pending_steps?: Array<{ type: string; description: string }>;
      legal?: { tax_id?: string };
      certificate?: { has_cer?: boolean; valid_until?: string };
    };
    return NextResponse.json({
      orgId: o.id,
      isProductionReady: !!o.is_production_ready,
      pendingSteps: o.pending_steps ?? [],
      taxId: o.legal?.tax_id ?? null,
      hasCertificate: !!o.certificate?.has_cer,
      certificateValidUntil: o.certificate?.valid_until ?? null,
      dashboardUrl: `https://app.facturapi.io/orgs/${o.id}`,
    });
  } catch (e) {
    return NextResponse.json({
      orgId: company.facturapiOrgId,
      error: e instanceof Error ? e.message : "Error consultando Facturapi",
    }, { status: 502 });
  }
}
