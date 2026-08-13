import { NextResponse } from "next/server";
import { requireMembership, withAuthz } from "@/lib/authz";
import { balanza } from "@/lib/contabilidad/posting";
import { balanceGeneralDesdeBalanza } from "@/lib/contabilidad/libro";
import { clavePeriodo, hojaBalanceGeneral } from "@/lib/contabilidad/reportes-xlsx";
import { headersDescargaXlsx, toXlsx } from "@/lib/export/xlsx";

// GET /api/contabilidad/balance-general?companyId=&year=&month= — balance
// general canónico para la UI de contabilidad (cualquier miembro; sin gate de
// módulo — /api/reporting/balance-general queda como espejo para satélites).
// Incluye el resultado en curso como renglón virtual para que la ecuación
// contable cuadre antes del cierre anual.
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const year = Number(searchParams.get("year"));
  const month = Number(searchParams.get("month"));
  if (!companyId || !year || !month) {
    return NextResponse.json({ error: "companyId, year y month requeridos" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);

  const rows = await balanza(companyId, year, month);
  const bg = balanceGeneralDesdeBalanza(rows);

  if (searchParams.get("format") === "xlsx") {
    return new NextResponse(new Uint8Array(toXlsx([hojaBalanceGeneral(bg)])), {
      headers: headersDescargaXlsx(`Balance general ${clavePeriodo(year, month)}.xlsx`),
    });
  }

  return NextResponse.json({ year, month, ...bg });
});
