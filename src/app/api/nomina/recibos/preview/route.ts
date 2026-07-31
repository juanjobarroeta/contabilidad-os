import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { previewRecibo } from "@/lib/nomina/preview-recibo";

// GET /api/nomina/recibos/preview?companyId=&payrollItemId= — representación
// impresa BORRADOR de un recibo calculado sin timbrar. Mismo shape que
// /api/facturas/[id]/representacion para reutilizar el visor tal cual.
// Sólo lectura — cualquier miembro (VIEWER incluido), igual que el hub.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    const payrollItemId = url.searchParams.get("payrollItemId");
    if (!companyId || !payrollItemId) {
      return NextResponse.json({ error: "companyId y payrollItemId requeridos" }, { status: 400 });
    }
    await requireMembership(companyId, undefined, req);

    const out = await previewRecibo(companyId, payrollItemId);
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });

    return NextResponse.json({
      representacion: out.rep,
      qrDataUrl: null,
      fromXml: false,
      cancelada: false,
      borrador: true,
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
