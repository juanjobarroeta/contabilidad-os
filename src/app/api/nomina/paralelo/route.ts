import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { resumenParalelo, MAX_CORRIDAS_RESUMEN } from "@/lib/nomina/paralelo";

// GET /api/nomina/paralelo?companyId=xxx&runs=6
//
// Nómina en paralelo: recalcula las últimas N corridas ORDINARIAS importadas
// del SAT con nuestro motor (tablas vigentes a cada fecha de pago) y devuelve
// el diff por empleado y concepto contra lo timbrado por el proveedor actual.
// SÓLO LECTURA: cálculo on-demand, sin persistencia, acotado a ≤12 corridas.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  // Lectura pura — cualquier miembro de la empresa (incluido VIEWER) puede verla.
  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const runsParam = Number(searchParams.get("runs") ?? "6");
  const limit = Number.isFinite(runsParam)
    ? Math.min(Math.max(Math.trunc(runsParam), 1), MAX_CORRIDAS_RESUMEN)
    : 6;

  const resumen = await resumenParalelo(companyId, { limit });
  return NextResponse.json(resumen);
}
