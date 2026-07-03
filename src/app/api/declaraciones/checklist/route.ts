import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { checklistDeclaracion } from "@/lib/fiscal/checklist-declaracion";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/declaraciones/checklist?companyId=&year=&month=
//
// Checklist de la declaración mensual: qué está listo y qué falta para
// declarar el periodo (sincronización SAT, cadena de declaraciones, bancos,
// REP, posición IVA/ISR, DIOT, nómina y fecha límite). Sólo lectura — la misma
// estructura que consumen la tarjeta de "Del mes" y el asistente.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const year = parseInt(searchParams.get("year") ?? "");
  const month = parseInt(searchParams.get("month") ?? "");

  if (!companyId || isNaN(year) || isNaN(month) || month < 1 || month > 12 || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "companyId, year y month son requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const checklist = await checklistDeclaracion(companyId, year, month);
  return NextResponse.json(checklist);
}
