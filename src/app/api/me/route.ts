import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isOperador } from "@/lib/authz";

// GET /api/me — datos ligeros del usuario para la UI (p.ej. mostrar herramientas
// internas sólo al operador de plataforma).
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ esOperador: await isOperador(session.user.id) });
}
