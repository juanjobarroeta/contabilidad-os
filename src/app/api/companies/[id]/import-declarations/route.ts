import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

// POST /api/companies/[id]/import-declarations
//
// Accepts an array of parsed declarations (from /api/onboarding/parse-document)
// and creates TaxDeclaration rows with isHistorical=true.
// Also updates Company.coeficienteUtilidad if an anual is included.

type Params = { params: Promise<{ id: string }> };

interface AcuseMensual {
  periodoMes?: number | null;
  periodoAnio?: number | null;
  tipoImpuesto?: "IVA" | "ISR" | "IVA_ISR" | "RETENCIONES" | null;
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
}

interface AcuseAnual {
  ejercicio?: number | null;
  coeficienteUtilidad?: number | null;
  utilidadFiscal?: number | null;
  isrCausado?: number | null;
  isrAPagar?: number | null;
  isrAFavor?: number | null;
  lineaCaptura?: string | null;
  fechaPresentacion?: string | null;
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: companyId } = await params;

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const body = await req.json() as {
    acuseAnual?: AcuseAnual | null;
    acusesMensuales?: (AcuseMensual | null)[];
  };

  const created: string[] = [];
  const errors: string[] = [];

  // Import annual declaration
  if (body.acuseAnual?.ejercicio) {
    const a = body.acuseAnual;
    const periodo = String(a.ejercicio);
    try {
      // Upsert — don't duplicate if already imported
      const existing = await prisma.taxDeclaration.findFirst({
        where: { companyId, tipo: "DECLARACION_ANUAL", periodo },
      });
      if (existing) {
        await prisma.taxDeclaration.update({
          where: { id: existing.id },
          data: {
            isHistorical: true,
            status: "FILED",
            isrIngresos: a.utilidadFiscal ?? null,
            isrPagar: a.isrAPagar ?? null,
            isrCoeficienteUtilidad: a.coeficienteUtilidad ?? null,
            lineaCaptura: a.lineaCaptura ?? null,
            fechaPresentacion: a.fechaPresentacion ? new Date(a.fechaPresentacion) : null,
          },
        });
        created.push(`Anual ${periodo} (actualizada)`);
      } else {
        await prisma.taxDeclaration.create({
          data: {
            companyId,
            tipo: "DECLARACION_ANUAL",
            periodo,
            status: "FILED",
            isHistorical: true,
            isrIngresos: a.utilidadFiscal ?? null,
            isrPagar: a.isrAPagar ?? null,
            isrCoeficienteUtilidad: a.coeficienteUtilidad ?? null,
            lineaCaptura: a.lineaCaptura ?? null,
            fechaPresentacion: a.fechaPresentacion ? new Date(a.fechaPresentacion) : null,
          },
        });
        created.push(`Anual ${periodo}`);
      }

      // Update Company.coeficienteUtilidad if present
      if (a.coeficienteUtilidad != null) {
        await prisma.company.update({
          where: { id: companyId },
          data: { coeficienteUtilidad: a.coeficienteUtilidad },
        });
      }
    } catch (e) {
      console.error("[import-declarations] Anual error:", e);
      errors.push(`Anual ${periodo}: error al guardar`);
    }
  }

  // Import monthly declarations
  if (body.acusesMensuales?.length) {
    for (const m of body.acusesMensuales) {
      if (!m || !m.periodoMes || !m.periodoAnio) continue;
      const periodo = `${m.periodoAnio}-${String(m.periodoMes).padStart(2, "0")}`;

      const tipos: ("IVA_MENSUAL" | "ISR_PROVISIONAL")[] = [];
      if (m.tipoImpuesto === "IVA" || m.tipoImpuesto === "IVA_ISR") tipos.push("IVA_MENSUAL");
      if (m.tipoImpuesto === "ISR" || m.tipoImpuesto === "IVA_ISR") tipos.push("ISR_PROVISIONAL");
      if (tipos.length === 0) continue;

      for (const tipo of tipos) {
        try {
          const existing = await prisma.taxDeclaration.findFirst({
            where: { companyId, tipo, periodo },
          });
          const data = {
            isHistorical: true,
            status: "FILED" as const,
            ivaTrasladadoCobrado: tipo === "IVA_MENSUAL" ? m.ivaCausado ?? null : null,
            ivaAcreditableGastado: tipo === "IVA_MENSUAL" ? m.ivaAcreditable ?? null : null,
            ivaPagar: tipo === "IVA_MENSUAL" ? m.ivaAPagar ?? null : null,
            ivaSaldoFavor: tipo === "IVA_MENSUAL" ? m.ivaAFavor ?? null : null,
            isrIngresos: tipo === "ISR_PROVISIONAL" ? m.isrIngresos ?? null : null,
            isrPagar: tipo === "ISR_PROVISIONAL" ? m.isrAPagar ?? null : null,
            isrCoeficienteUtilidad: tipo === "ISR_PROVISIONAL" ? m.coeficienteUtilidadAplicado ?? null : null,
            lineaCaptura: m.lineaCaptura ?? null,
            fechaPresentacion: m.fechaPresentacion ? new Date(m.fechaPresentacion) : null,
          };

          if (existing) {
            await prisma.taxDeclaration.update({ where: { id: existing.id }, data });
            created.push(`${tipo === "IVA_MENSUAL" ? "IVA" : "ISR"} ${periodo} (actualizada)`);
          } else {
            await prisma.taxDeclaration.create({
              data: { companyId, tipo, periodo, ...data },
            });
            created.push(`${tipo === "IVA_MENSUAL" ? "IVA" : "ISR"} ${periodo}`);
          }
        } catch (e) {
          console.error("[import-declarations] Mensual error:", e);
          errors.push(`${tipo} ${periodo}: error al guardar`);
        }
      }
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    created,
    errors,
    total: created.length,
  });
}
