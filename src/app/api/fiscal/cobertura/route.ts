import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { coberturaConCotejo } from "@/lib/fiscal/cobertura-con-cotejo";
import { coberturaInpc, inpc } from "@/lib/fiscal/inpc";
import { fetchTipoCambioFix } from "@/lib/fiscal/banxico";

// GET /api/fiscal/cobertura
// Reporte time-aware de frescura de los datos fiscales versionados (INPC,
// tarifas, subsidio, UMA, salario mínimo) contra su calendario de publicación,
// a la hora del SERVIDOR. Global (no por empresa) — los datos son del país.
// Incluye además referencias informativas: último INPC cargado y el FIX de
// Banxico (sólo dato, sin cálculo de fluctuación todavía).
//
// `?asOf=YYYY-MM-DD` permite simular una fecha (para pruebas); por defecto = ahora.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const asOfParam = new URL(req.url).searchParams.get("asOf");
  const asOf = asOfParam ? new Date(asOfParam) : new Date();
  if (isNaN(asOf.getTime())) return NextResponse.json({ error: "asOf inválido" }, { status: 400 });

  const [cobertura, fix] = await Promise.all([coberturaConCotejo(asOf), fetchTipoCambioFix()]);

  const ic = coberturaInpc();
  const inpcUltimo =
    ic && inpc(ic.year, ic.month) != null
      ? { periodo: `${ic.year}-${String(ic.month).padStart(2, "0")}`, valor: inpc(ic.year, ic.month)! }
      : null;

  return NextResponse.json({ ...cobertura, inpcUltimo, tipoCambioFix: fix });
}
