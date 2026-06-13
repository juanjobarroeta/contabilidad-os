import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { empresasAccesiblesIds } from "@/lib/authz";
import { declaracionesFaltantesEmpresa, type AcuseFaltante } from "@/lib/fiscal/cobertura-declaraciones";

// GET /api/declaraciones/cobertura
// Acuses faltantes por empresa accesible — alimenta el banner y la pantalla de
// captura (/declaraciones). Operador-aware: empresasAccesiblesIds ya abarca
// todos los despachos para un operador de plataforma.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ids = await empresasAccesiblesIds(session.user.id);
  if (ids.length === 0) return NextResponse.json({ total: 0, empresas: [] });

  const companies = await prisma.company.findMany({
    where: { id: { in: ids }, isActive: true },
    select: { id: true, rfc: true, razonSocial: true },
    orderBy: { razonSocial: "asc" },
  });

  const empresas: {
    companyId: string;
    rfc: string;
    razonSocial: string;
    faltantes: AcuseFaltante[];
  }[] = [];
  let total = 0;

  // Secuencial-ish pero barato (sólo lecturas agregadas por empresa).
  for (const c of companies) {
    const faltantes = await declaracionesFaltantesEmpresa(c.id);
    if (faltantes.length > 0) {
      empresas.push({ companyId: c.id, rfc: c.rfc, razonSocial: c.razonSocial, faltantes });
      total += faltantes.length;
    }
  }

  return NextResponse.json({ total, empresasConFaltantes: empresas.length, empresas });
}
