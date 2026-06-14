import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOperador } from "@/lib/authz";
import { microUsdACentavosMxn } from "@/lib/costos/rates";
import { fetchTipoCambioFix } from "@/lib/fiscal/banxico";

// GET /api/rentabilidad/tendencia?meses=6
// Serie mensual del costo-por-servir total (con desglose LLM/Syntage), para ver
// la DIRECCIÓN del costo, no sólo el mes actual. Sólo operador. Rollup por mes en
// Postgres (date_trunc) para que escale con el volumen de CostEvent.

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isOperador(session.user.id))) {
    return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const meses = Math.min(Math.max(parseInt(searchParams.get("meses") ?? "6") || 6, 1), 24);

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - (meses - 1), 1);

  const rows = await prisma.$queryRaw<{ periodo: string; categoria: string; micro: bigint }[]>`
    SELECT to_char(date_trunc('month', "occurredAt"), 'YYYY-MM') AS periodo,
           categoria,
           SUM("costoMicroUsd")::bigint AS micro
    FROM "CostEvent"
    WHERE "occurredAt" >= ${start}
    GROUP BY 1, 2
    ORDER BY 1`;

  const fix = (await fetchTipoCambioFix())?.valor ?? null;
  const fixUsado = fix ?? 20;

  // Mapa periodo → { llm, syntage } en micro-USD.
  const porPeriodo = new Map<string, { llm: number; syntage: number }>();
  for (const r of rows) {
    const e = porPeriodo.get(r.periodo) ?? { llm: 0, syntage: 0 };
    const micro = Number(r.micro);
    if (r.categoria === "LLM") e.llm += micro;
    else if (r.categoria === "SYNTAGE") e.syntage += micro;
    porPeriodo.set(r.periodo, e);
  }

  // Rellena todos los meses del rango (incluye los de costo cero).
  const serie: { periodo: string; llmCentavos: number; syntageCentavos: number; totalCentavos: number }[] = [];
  for (let i = 0; i < meses; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - (meses - 1) + i, 1);
    const periodo = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const e = porPeriodo.get(periodo) ?? { llm: 0, syntage: 0 };
    const llmCentavos = microUsdACentavosMxn(e.llm, fixUsado);
    const syntageCentavos = microUsdACentavosMxn(e.syntage, fixUsado);
    serie.push({ periodo, llmCentavos, syntageCentavos, totalCentavos: llmCentavos + syntageCentavos });
  }

  return NextResponse.json({ fixMxnPorUsd: fixUsado, fixReal: fix != null, serie });
}
