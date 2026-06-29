/**
 * GET /api/reporting/estado-resultados?companyId=&year=&month=
 *
 * Official income statement (estado de resultados) for a posted period, from
 * the double-entry ledger. Read-only; for satellite apps to mirror. Requires
 * membership + the PADEL module.
 */

import { NextResponse } from "next/server";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { estadoResultados } from "@/lib/contabilidad/posting";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const year = Number(searchParams.get("year"));
  const month = Number(searchParams.get("month"));
  if (!companyId || !year || !month) {
    return NextResponse.json({ error: "companyId, year y month requeridos" }, { status: 400 });
  }

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PADEL", req);

  const data = await estadoResultados(companyId, year, month);
  return NextResponse.json(data);
});
