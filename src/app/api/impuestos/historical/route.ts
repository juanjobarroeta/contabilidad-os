import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

// GET /api/impuestos/historical?companyId=xxx
// Returns all historical (imported) tax declarations for a company

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const declarations = await prisma.taxDeclaration.findMany({
    where: { companyId, isHistorical: true },
    select: {
      id: true,
      tipo: true,
      periodo: true,
      status: true,
      isrPagar: true,
      ivaPagar: true,
      ivaSaldoFavor: true,
      isrCoeficienteUtilidad: true,
      ivaTrasladadoCobrado: true,
      ivaAcreditableGastado: true,
      isrIngresos: true,
      fechaPresentacion: true,
      lineaCaptura: true,
      createdAt: true,
    },
    orderBy: { periodo: "desc" },
  });

  return NextResponse.json({ declarations });
}
