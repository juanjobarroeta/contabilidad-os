import { NextResponse } from "next/server";
import { withAuthz } from "@/lib/authz";
import { parsePeriodoQuery, requireCierreGuiado } from "@/lib/cierre/gate";
import { evaluarCierre } from "@/lib/cierre/evaluar";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cierre/estado?companyId=&year=&month=
//
// El estado del cierre guiado del periodo: los doce pasos con lo que dicen
// los motores hoy y lo que decidió el humano. Persiste la evaluación (es la
// misma verdad que lee «Hoy» y el pase diario). Plan PRO.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

export const GET = withAuthz(async (req: Request) => {
  const p = parsePeriodoQuery(new URL(req.url).searchParams);
  if (!p) return NextResponse.json({ error: "companyId, year y month son requeridos" }, { status: 400 });
  await requireCierreGuiado(p.companyId, undefined, req);
  const cierre = await evaluarCierre(p.companyId, p.year, p.month, { persistir: true });
  return NextResponse.json(cierre);
});
