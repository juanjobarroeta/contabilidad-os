import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { readRegimenDeductionEvidence } from "@/lib/fiscal/regimen-deduction-evidence";
import { DEDUCTION_REVIEW_REASONS, DEDUCTION_REVIEW_YEAR } from "@/lib/fiscal/regimen-deduction-summary";

const headers = { "Cache-Control": "no-store" };
const PREVIEW_LIMIT = 25;

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
  const result = await readRegimenDeductionEvidence(companyId, year, month);
  if (!result) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404, headers });
  return NextResponse.json({
    ...result,
    renglones: result.renglones.slice(0, PREVIEW_LIMIT),
    documental: { ...result.documental, pendientes: result.documental.pendientes.slice(0, PREVIEW_LIMIT) },
    alcance: "BASES_DOCUMENTALES_DE_EGRESOS_Y_REVISION_DE_DEDUCCIONES",
    revisionFiscal: { ejercicio: DEDUCTION_REVIEW_YEAR, criterios: DEDUCTION_REVIEW_REASONS },
    limitaciones: [
      "Los importes son bases documentales asignadas por régimen, no deducciones autorizadas.",
      "La clasificación manual y la asignación revisada no acreditan pago, necesidad, límites o requisitos fiscales.",
      "PUE se agrupa por emisión sin acreditar pago; REP por FechaPago sin inferir FormaDePagoP del CFDI padre.",
      "Inversiones, inventarios, deducciones personales, arrendamiento y plataformas requieren tratamiento propio.",
      "RESICO PF y PM son distintos. No determina IVA, retenciones, créditos, ISR, declaración ni cierre.",
      "La lista detecta necesidades de revisión; no prueba que la importación esté completa ni sustituye la revisión del contador.",
    ],
  }, { headers });
}
