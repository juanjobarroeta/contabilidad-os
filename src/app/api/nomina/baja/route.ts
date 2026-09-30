import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { darDeBaja } from "@/lib/nomina/baja";

// POST /api/nomina/baja
// Deactivates an employee, creates IMSS Baja movement, and optionally
// calculates finiquito/liquidación (regla en lib/nomina/baja.ts).
//
// Body: { companyId, employeeId, fechaBaja, motivo, diasSalarioPendiente? }
// motivo: "VOLUNTARIA" | "JUSTIFICADA" | "INJUSTIFICADA"

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, employeeId, fechaBaja, motivo, diasSalarioPendiente } = body;

  if (!companyId || !employeeId || !fechaBaja || !motivo) {
    return NextResponse.json({ error: "companyId, employeeId, fechaBaja y motivo requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const r = await darDeBaja({ companyId, employeeId, fechaBaja, motivo: String(motivo), diasSalarioPendiente });
  return NextResponse.json(r.body, { status: r.status });
}
