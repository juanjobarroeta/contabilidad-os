import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSubscription } from "@/lib/subscription";
import { AuthzError } from "@/lib/authz";
import { provisionFacturapiOrg } from "@/lib/facturapi";
import { seedChartOfAccounts } from "@/lib/contabilidad/seed-catalog";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json([], { status: 401 });

  const memberships = await prisma.companyMember.findMany({
    where: { userId: session.user.id },
    include: {
      company: {
        select: {
          id: true,
          rfc: true,
          razonSocial: true,
          regimenFiscal: true,
          codigoPostal: true,
          isActive: true,
        },
      },
    },
  });

  const companies = memberships
    .filter((m) => m.company.isActive)
    .map((m) => m.company);

  return NextResponse.json(companies);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    await requireActiveSubscription(session.user.id);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const body = await req.json();
  const {
    rfc, razonSocial, regimenFiscal, codigoPostal, domicilioFiscal,
    nombreComercial, email, telefono, actividadEconomica,
    csdCer, csdKey, csdPassword,
    fielCer, fielKey, fielPassword,
  } = body;

  if (!rfc || !razonSocial || !regimenFiscal || !codigoPostal) {
    return NextResponse.json({ error: "Faltan campos requeridos" }, { status: 400 });
  }

  const company = await prisma.company.create({
    data: {
      rfc: rfc.toUpperCase(),
      razonSocial,
      regimenFiscal,
      codigoPostal,
      domicilioFiscal,
      nombreComercial,
      email,
      telefono,
      actividadEconomica,
      csdCer,
      csdKey,
      csdPassword,
      fielCer,
      fielKey,
      fielPassword,
      members: {
        create: {
          userId: session.user.id,
          role: "OWNER",
        },
      },
      // Every new company gets the base accounting module enabled.
      // Add-on modules (CONSTRUCCION, FLOTA, …) are enabled separately
      // by an admin or by the Stripe webhook on add-on purchase.
      modules: {
        create: { modulo: "CONTABILIDAD" },
      },
    },
  });

  // Seed the SAT chart of accounts. Best-effort — don't fail the request.
  try {
    await seedChartOfAccounts(company.id);
  } catch (e) {
    console.error("[companies] seedChartOfAccounts failed:", e);
  }

  // Auto-provision Facturapi org. Best-effort: company creation must not fail
  // if Facturapi is down. The result is returned to the client so the UI can
  // surface a warning ("CSD missing", "Facturapi down", etc.).
  const facturapi = await provisionFacturapiOrg(company.id);

  return NextResponse.json({ ...company, facturapi }, { status: 201 });
}
