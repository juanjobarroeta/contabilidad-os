import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isOperador } from "@/lib/authz";
import { computeRentabilidad } from "@/lib/costos/rentabilidad";

// GET /api/rentabilidad?year=YYYY&month=M
// Unit economics (SÓLO operador): costo-por-servir del periodo vs precio mensual
// → margen, por empresa y con roll-up por despacho.

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isOperador(session.user.id))) {
    return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const now = new Date();
  const year = parseInt(searchParams.get("year") ?? "") || now.getFullYear();
  const month = parseInt(searchParams.get("month") ?? "") || now.getMonth() + 1;

  return NextResponse.json(await computeRentabilidad(year, month));
}
