import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { verificarContraSat } from "@/lib/fiscal/verificacion-sat";

// GET /api/papeles/verificacion?companyId=xxx&year=2026&month=5
//
// Verificación contra el SAT (fire test): compara la balanza del libro, el IVA y
// el ISR del periodo contra lo presentado/registrado en el SAT, y dictamina
// coincide / diverge / incompleto. Sólo lectura del libro.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const year = parseInt(searchParams.get("year") ?? "");
  const month = parseInt(searchParams.get("month") ?? "");

  if (!companyId || isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: "companyId, year, month requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const periodo = `${year}-${String(month).padStart(2, "0")}`;
  try {
    const result = await verificarContraSat(companyId, periodo);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Error en la verificación" },
      { status: 500 }
    );
  }
}
