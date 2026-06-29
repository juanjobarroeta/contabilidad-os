/**
 * GET /api/reporting/balance-general?companyId=&year=&month=
 *
 * Official balance sheet, derived from the trial balance (balanza) of a posted
 * period: cumulative saldoFinal grouped into ACTIVO / PASIVO / CAPITAL. Read-only
 * mirror for satellite apps. Requires membership + the PADEL module.
 */

import { NextResponse } from "next/server";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { balanza } from "@/lib/contabilidad/posting";

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

  const rows = await balanza(companyId, year, month);

  const sección = (tipo: string) =>
    rows
      .filter((r) => r.tipo === tipo && r.nivel >= 3 && Math.abs(r.saldoFinal) >= 0.01)
      .map((r) => ({ cuentaSAT: r.cuentaSAT, subcuenta: r.subcuenta, nombre: r.nombre, monto: r.saldoFinal }));

  const activo = sección("ACTIVO");
  const pasivo = sección("PASIVO");
  const capital = sección("CAPITAL");
  const sum = (xs: { monto: number }[]) => xs.reduce((s, x) => s + x.monto, 0);

  const totalActivo = sum(activo);
  const totalPasivo = sum(pasivo);
  const totalCapital = sum(capital);

  return NextResponse.json({
    year,
    month,
    activo,
    pasivo,
    capital,
    totalActivo,
    totalPasivo,
    totalCapital,
    // ACTIVO = PASIVO + CAPITAL when the books balance; expose the check.
    descuadre: Math.round((totalActivo - (totalPasivo + totalCapital)) * 100) / 100,
  });
});
