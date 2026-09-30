import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { readRegimenIncomeEvidence } from "@/lib/fiscal/regimen-income-evidence";

const PREVIEW_LIMIT = 25;
const headers = { "Cache-Control": "no-store" };

// Read-only evidence contract. It does not invoke or unlock any tax engine.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId")?.trim() ?? "";
  const year = Number(searchParams.get("year")), month = Number(searchParams.get("month"));
  if (!companyId || !Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: "companyId, year y month válidos son requeridos" }, { status: 400, headers });
  }
  if (!await getEffectiveCompanyMembership(session.user.id, companyId)) {
    return NextResponse.json({ error: "Sin acceso" }, { status: 403, headers });
  }
  const result = await readRegimenIncomeEvidence(companyId, year, month);
  if (!result) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404, headers });
  return NextResponse.json({
    ...result,
    resumen: { renglones: result.renglones.length, pendientes: result.pendientes.length },
    renglones: result.renglones.slice(0, PREVIEW_LIMIT),
    pendientes: result.pendientes.slice(0, PREVIEW_LIMIT),
    alcance: "BASES_DOCUMENTALES_PUE_Y_REP_POR_REGIMEN",
    limitaciones: [
      "PUE se agrupa por emisión: no acredita cobro ni determina ingresos acumulables.",
      "PPD se agrupa por FechaPago del REP, con historial acumulado y base neta de descuento.",
      "Notas de crédito, moneda extranjera, evidencia contradictoria y cambios de régimen requieren revisión.",
      "Los totales de PUE y REP son separados. No determinan ISR, IVA, deducciones, retenciones ni créditos.",
      "No modifica cálculos, declaraciones o cierres; la composición automática sigue bloqueada.",
    ],
  }, { headers });
}
