import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { ajusteAnualEmpresa } from "@/lib/nomina/ajuste-anual";

// GET /api/nomina/ajuste-anual?companyId=xxx&ejercicio=2025
//
// Ajuste anual de ISR de sueldos (Art. 97 LISR): recalcula por trabajador el
// impuesto anual del ejercicio (tarifa Art. 152 + subsidio al empleo del
// decreto DOF 01-may-2024, Art. Tercero) y lo compara contra la suma de las
// retenciones mensuales timbradas. SÓLO LECTURA: reporte on-demand, sin
// persistencia — NO modifica ninguna corrida (aplicarlo a diciembre es fase 2).
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  // Lectura pura — cualquier miembro de la empresa (incluido VIEWER) puede verla.
  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const ejercicioParam = Number(searchParams.get("ejercicio") ?? new Date().getFullYear());
  if (!Number.isInteger(ejercicioParam) || ejercicioParam < 2000 || ejercicioParam > 2100) {
    return NextResponse.json({ error: "ejercicio inválido" }, { status: 400 });
  }

  const reporte = await ajusteAnualEmpresa(companyId, ejercicioParam);
  return NextResponse.json(reporte);
}
