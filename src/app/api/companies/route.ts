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
    onboardingPackage,
  } = body as {
    rfc: string; razonSocial: string; regimenFiscal: string; codigoPostal: string;
    domicilioFiscal?: string; nombreComercial?: string; email?: string;
    telefono?: string; actividadEconomica?: string;
    csdCer?: string; csdKey?: string; csdPassword?: string;
    fielCer?: string; fielKey?: string; fielPassword?: string;
    onboardingPackage?: {
      imss?: {
        registroPatronal?: string | null;
        clase?: string | null;
        fraccion?: string | null;
        prima?: number | null;
      } | null;
      acuseAnual?: {
        ejercicio?: number | null;
        coeficienteUtilidad?: number | null;
        utilidadFiscal?: number | null;
        isrCausado?: number | null;
        isrAPagar?: number | null;
        lineaCaptura?: string | null;
        fechaPresentacion?: string | null;
      } | null;
      acusesMensuales?: Array<{
        periodoMes?: number | null;
        periodoAnio?: number | null;
        tipoImpuesto?: "IVA" | "ISR" | "IVA_ISR" | "RETENCIONES" | null;
        tipoPago?: string | null;
        ivaCausado?: number | null;
        ivaAcreditable?: number | null;
        ivaAPagar?: number | null;
        ivaAFavor?: number | null;
        ivaSaldoFavorAplicado?: number | null;
        isrIngresos?: number | null;
        isrRetenciones?: number | null;
        isrPagosAnteriores?: number | null;
        isrAPagar?: number | null;
        coeficienteUtilidadAplicado?: number | null;
        lineaCaptura?: string | null;
        fechaPresentacion?: string | null;
      } | null>;
    };
  };

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

  // Extract IMSS + anual fields from onboardingPackage so they persist on Company row
  const registroPatronal = onboardingPackage?.imss?.registroPatronal ?? null;
  const coeficienteUtilidad = onboardingPackage?.acuseAnual?.coeficienteUtilidad ?? null;

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
      registroPatronal: registroPatronal ?? undefined,
      coeficienteUtilidad: coeficienteUtilidad ?? undefined,
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

  // Persist historical monthly declarations parsed from acuses
  // These are flagged isHistorical=true so they're treated as baseline data
  // by carryover logic but hidden from "periodos pendientes" lists.
  if (onboardingPackage?.acusesMensuales?.length) {
    for (const m of onboardingPackage.acusesMensuales) {
      if (!m || !m.periodoMes || !m.periodoAnio) continue;
      const periodo = `${m.periodoAnio}-${String(m.periodoMes).padStart(2, "0")}`;

      // One acuse can cover both IVA and ISR, or just one. We create a row
      // per impuesto type so the tax module can read them like organic rows.
      const tipos: ("IVA_MENSUAL" | "ISR_PROVISIONAL")[] = [];
      if (m.tipoImpuesto === "IVA" || m.tipoImpuesto === "IVA_ISR") tipos.push("IVA_MENSUAL");
      if (m.tipoImpuesto === "ISR" || m.tipoImpuesto === "IVA_ISR") tipos.push("ISR_PROVISIONAL");
      if (tipos.length === 0) continue;

      for (const tipo of tipos) {
        try {
          await prisma.taxDeclaration.create({
            data: {
              companyId: company.id,
              tipo,
              periodo,
              status: "FILED",
              isHistorical: true,
              ivaTrasladadoCobrado: tipo === "IVA_MENSUAL" ? m.ivaCausado ?? null : null,
              ivaAcreditableGastado: tipo === "IVA_MENSUAL" ? m.ivaAcreditable ?? null : null,
              ivaPagar: tipo === "IVA_MENSUAL" ? m.ivaAPagar ?? null : null,
              ivaSaldoFavor: tipo === "IVA_MENSUAL" ? m.ivaAFavor ?? null : null,
              isrIngresos: tipo === "ISR_PROVISIONAL" ? m.isrIngresos ?? null : null,
              isrPagar: tipo === "ISR_PROVISIONAL" ? m.isrAPagar ?? null : null,
              isrCoeficienteUtilidad:
                tipo === "ISR_PROVISIONAL" ? m.coeficienteUtilidadAplicado ?? null : null,
              lineaCaptura: m.lineaCaptura ?? null,
              fechaPresentacion: m.fechaPresentacion ? new Date(m.fechaPresentacion) : null,
            },
          });
        } catch (e) {
          console.error("[companies] Historical declaration create failed:", e);
        }
      }
    }
  }

  // Persist annual declaration if present
  if (onboardingPackage?.acuseAnual?.ejercicio) {
    try {
      const a = onboardingPackage.acuseAnual;
      await prisma.taxDeclaration.create({
        data: {
          companyId: company.id,
          tipo: "DECLARACION_ANUAL",
          periodo: String(a.ejercicio),
          status: "FILED",
          isHistorical: true,
          isrIngresos: a.utilidadFiscal ?? null,
          isrPagar: a.isrAPagar ?? null,
          isrCoeficienteUtilidad: a.coeficienteUtilidad ?? null,
          lineaCaptura: a.lineaCaptura ?? null,
          fechaPresentacion: a.fechaPresentacion ? new Date(a.fechaPresentacion) : null,
        },
      });
    } catch (e) {
      console.error("[companies] Historical anual create failed:", e);
    }
  }

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
