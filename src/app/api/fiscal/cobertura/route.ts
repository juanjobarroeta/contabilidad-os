import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { evaluarCoberturaFiscal } from "@/lib/fiscal/cobertura-datos";

// GET /api/fiscal/cobertura
// Reporte time-aware de frescura de los datos fiscales versionados (INPC,
// tarifas, subsidio, UMA, salario mínimo) contra su calendario de publicación,
// a la hora del SERVIDOR. Global (no por empresa) — los datos son del país.
//
// `?asOf=YYYY-MM-DD` permite simular una fecha (para pruebas); por defecto = ahora.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const asOfParam = new URL(req.url).searchParams.get("asOf");
  const asOf = asOfParam ? new Date(asOfParam) : new Date();
  if (isNaN(asOf.getTime())) return NextResponse.json({ error: "asOf inválido" }, { status: 400 });

  return NextResponse.json(evaluarCoberturaFiscal(asOf));
}
