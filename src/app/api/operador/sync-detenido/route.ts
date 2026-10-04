import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isOperador } from "@/lib/authz";
import { empresasConSyncDetenida } from "@/lib/sat-salud";

// GET /api/operador/sync-detenido → empresas cuya descarga del SAT está
// detenida (e.firma vencida, revocada por el SAT, o sin avanzar en 7 días),
// con desde cuándo y a cuántos usuarios se les avisó. Sólo operador.
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isOperador(session.user.id))) return NextResponse.json({ error: "Sólo operador" }, { status: 403 });
  const empresas = await empresasConSyncDetenida();
  return NextResponse.json({ empresas });
}
