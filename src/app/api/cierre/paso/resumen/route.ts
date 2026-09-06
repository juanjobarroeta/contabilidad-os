import { NextResponse } from "next/server";
import { withAuthz } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { parsePeriodoQuery, requireCierreGuiado } from "@/lib/cierre/gate";
import { aperturaDelPaso } from "@/lib/cierre/resumen-paso";
import { esClavePaso } from "@/lib/cierre/claves";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cierre/paso/resumen?companyId=&year=&month=&clave=
//
// La apertura del paso escrita por el copiloto, cacheada por el hash de la
// evidencia: sólo se paga cuando los datos del paso cambiaron. Plan PRO.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = withAuthz(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const p = parsePeriodoQuery(sp);
  const clave = sp.get("clave");
  if (!p || !esClavePaso(clave)) {
    return NextResponse.json({ error: "companyId, year, month y clave son requeridos" }, { status: 400 });
  }
  const { user } = await requireCierreGuiado(p.companyId, undefined, req);
  const empresa = await prisma.company.findUnique({ where: { id: p.companyId }, select: { razonSocial: true } });
  const r = await aperturaDelPaso({
    companyId: p.companyId,
    year: p.year,
    month: p.month,
    clave,
    userId: user.id,
    empresa: empresa?.razonSocial ?? "la empresa",
  });
  return NextResponse.json(r);
});
