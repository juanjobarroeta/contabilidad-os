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

  // Two access paths, union'd and deduped:
  //   1. Direct CompanyMember rows (explicit invitations)
  //   2. Companies owned by a Despacho the user is a member of
  const [direct, despachoMember] = await Promise.all([
    prisma.companyMember.findMany({
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
    }),
    prisma.despachoMember.findFirst({
      where: { userId: session.user.id },
      select: { despachoId: true },
    }),
  ]);

  let despachoCompanies: typeof direct[number]["company"][] = [];
  if (despachoMember) {
    despachoCompanies = await prisma.company.findMany({
      where: { despachoId: despachoMember.despachoId },
      select: {
        id: true,
        rfc: true,
        razonSocial: true,
        regimenFiscal: true,
        codigoPostal: true,
        isActive: true,
      },
    });
  }

  // Union by id
  const byId = new Map<string, typeof direct[number]["company"]>();
  for (const m of direct) {
    if (m.company.isActive) byId.set(m.company.id, m.company);
  }
  for (const c of despachoCompanies) {
    if (c.isActive) byId.set(c.id, c);
  }

  return NextResponse.json(Array.from(byId.values()));
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

  // Auto-link to the creator's despacho (if they belong to one). Every
  // despacho member automatically gets access to companies the despacho
  // owns, so this is the main path for teams/firms. The creator still gets
  // an explicit CompanyMember(OWNER) row too for unambiguous ownership
  // (e.g. only explicit OWNERs can delete or transfer the company).
  const despachoMembership = await prisma.despachoMember.findFirst({
    where: { userId: session.user.id },
    select: { despachoId: true },
  });

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
      despachoId: despachoMembership?.despachoId ?? null,
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
