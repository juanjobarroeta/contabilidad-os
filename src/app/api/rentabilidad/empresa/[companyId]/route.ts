import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isOperador } from "@/lib/authz";
import { computeEmpresaDetalle } from "@/lib/costos/empresa-detalle";

// GET /api/rentabilidad/empresa/[companyId]?year=YYYY&month=M
// Drill-down (SÓLO operador): costo del mes desglosado por subtipo + cobertura
// de datos (qué extracciones aterrizaron de verdad).

export async function GET(
  req: Request,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isOperador(session.user.id))) {
    return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });
  }

  const { companyId } = await params;
  const { searchParams } = new URL(req.url);
  const now = new Date();
  const year = parseInt(searchParams.get("year") ?? "") || now.getFullYear();
  const month = parseInt(searchParams.get("month") ?? "") || now.getMonth() + 1;

  const detalle = await computeEmpresaDetalle(companyId, year, month);
  if (!detalle) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });
  return NextResponse.json(detalle);
}
